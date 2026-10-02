/**
 * Deterministic simulation of TrackingService's trip-start / record / trip-end decision logic.
 * NOT the device runtime — it mirrors the exact constants + decision rules from
 * TrackingService.kt (the DISTANCE-BASED design; the old speed-averaging engine this file used
 * to model is retired) so the algorithm can be proven without a phone. Runtime-only concerns
 * (Doze, whether the fused provider actually stops emitting) still need on-device verification.
 *
 * Position is modelled as a 1-D scalar in METRES from an origin; "distance" is abs difference.
 *
 * Trip START is StartGate (the 150 m rest circle), through its mirror in start-gate.mjs — the
 * same class start-gate.sim.mjs exercises on its own, here wired into a whole trip.
 *
 * Run: node modules/vehicle-tracker/__sim__/stop-logic.sim.mjs
 */

import { StartGate, LegacyStart, Decision } from './start-gate.mjs';

// ── Constants (must match TrackingService.kt) ──
const TRIP_START_VEHICLE_MIN_SPEED_KMH = 0.8;
const TRIP_START_MAX_ACCURACY_M = 50;
const FOOT_VETO_MS = 10 * 60 * 1000;
const ACTIVITY_FRESH_MS = 90_000;
const PRE_START_BUFFER_MS = 30 * 60 * 1000;
const PRE_START_BUFFER_MAX = 240;
const PRE_START_BUFFER_SPACING_M = 5;
const POINT_DISTANCE_M = 10;
const RECORD_MIN_INTERVAL_MS = 8_000;
const RECORD_MIN_MOVE_M = 3;
const RECORD_MOVING_SPEED_KMH = 3.0;
const MAX_PLAUSIBLE_SPEED_KMH = 180.0;
// The DEFAULT stop timeout. A project can override it from the admin panel (2-30 min); the
// engine below takes it as an argument exactly like the service reads TrackingConfig on each tick.
const TRIP_END_NO_MOVE_MS = 10 * 60 * 1000;
const TICK_INTERVAL_MS = 20_000;
const MAX_ACCURACY_M = 100;
const TRIP_ACTIVE_MAX_ACCURACY_M = 50;
const STOP_CLOCK_MOVE_M = 30;
const FIX_INTERVAL_MS = 2_000;
// GPS-jump vetoes and confinement (2026-10-01 field case, trip 6abe7d98) — see TrackingService.kt.
const DOPPLER_CONFIRM_KMH = 5.0;
const DOPPLER_CREDIBLE_FIXES = 3;
const JUMP_IMPLIED_KMH = 5.0;
const JUMP_DOPPLER_MAX_KMH = 1.5;
const CONFINE_WINDOW_MS = 5 * 60 * 1000;
const CONFINE_RADIUS_M = 40;
const CONFINE_DOPPLER_MAX_KMH = 3.0;
// SIM_NO_VETOES=1 runs the engine WITHOUT these rules and with the previous start gates — to show
// the field scenarios below fail on the old logic, i.e. that they really reproduce the bug.
const VETOES = process.env.SIM_NO_VETOES !== '1';

function makeEngine(tripEndAfterMs = TRIP_END_NO_MOVE_MS) {
  let tripId = null;
  const gate = VETOES ? new StartGate() : new LegacyStart();
  const at = (pos) => ({ x: pos, y: 0 });
  let lastRecordedPos = 0;
  let lastRecordedAtMs = 0;
  let hasLastRecorded = false;
  let lastMovedMs = 0;
  // The stop clock's anchor: where the vehicle stood when it was last judged to be travelling.
  // Drift orbits its anchor and never accumulates; a crawl walks away from it.
  let stopAnchorPos = 0;
  let hasStopAnchor = false;
  let stopAnchorTime = 0;
  let anchorMaxDoppler = -1;
  /** In-trip fixes at DOPPLER_CONFIRM_KMH+: this trip's Doppler has shown it can read motion. */
  let tripDopplerMovingFixes = 0;
  /** In-trip fixes of the last CONFINE_WINDOW_MS: { now, pos, doppler }. */
  let confineWindow = [];
  function setStopAnchor(now, pos, doppler) {
    stopAnchorPos = pos;
    hasStopAnchor = true;
    stopAnchorTime = now;
    anchorMaxDoppler = doppler ?? -1;
  }
  function isConfined(now) {
    if (confineWindow.length < 4) return false;
    if (now - confineWindow[0].now < CONFINE_WINDOW_MS * 0.9) return false;
    const c = confineWindow.reduce((a, f) => a + f.pos, 0) / confineWindow.length;
    if (confineWindow.some((f) => Math.abs(f.pos - c) > CONFINE_RADIUS_M)) return false;
    const withDoppler = confineWindow.filter((f) => f.doppler !== null);
    const moving = withDoppler.filter((f) => f.doppler >= CONFINE_DOPPLER_MAX_KMH).length;
    return moving * 10 <= withDoppler.length;
  }
  let endPoint = null; // position of the last "ended" marker, null if none was written
  // Activity Recognition state: verdicts land on transitions, with a timestamp.
  let lastActivity = null;
  let lastActivityAt = -Infinity;
  /** When the continuous activity feed last reported a vehicle with confidence. */
  let arSaysVehicleAt = null;
  let prevSeenActivity = null;
  // Pre-start buffer of idle fixes: { now, pos }.
  let buffer = [];
  const points = [];
  const events = [];

  const fmt = (ms) =>
    `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

  function startTrip(now, pos, gateName, startDoppler = null) {
    tripId = `T${now}`;
    // Flush the buffered departure BEFORE the start point — original timestamps, so the trip
    // begins where and when the vehicle did, not 150 m later where the gate recognised it.
    // Exactly the service's flush: StartGate names the origin (the last fix it saw the phone
    // standing at); every buffered fix after it is the departure.
    const origin = gate.routeOrigin(buffer.map((b) => b.now), now);
    gate.clear();
    let flushed = 0;
    let prev = null;
    if (origin.isRoutePoint) {
      prev = { now: origin.elapsedMs, pos: origin.pos.x };
      points.push(prev);
      flushed++;
    }
    for (const b of buffer) {
      if (b.now <= origin.elapsedMs || b.now >= now) continue;
      if (prev) {
        const d = Math.abs(b.pos - prev.pos);
        if (d < Math.max(8, (b.accuracy ?? 30) * 0.75)) continue; // stationary jitter
        if ((d / (Math.max(1, b.now - prev.now) / 1000)) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) continue;
      }
      points.push({ now: b.now, pos: b.pos });
      prev = b;
      flushed++;
    }
    buffer = [];
    lastRecordedPos = pos;
    lastRecordedAtMs = now;
    hasLastRecorded = true;
    lastMovedMs = now;
    setStopAnchor(now, pos, startDoppler);
    confineWindow = [];
    tripDopplerMovingFixes = 0;
    points.push({ now, pos });
    events.push(`${fmt(now)} START (${gateName}, ${flushed} pre-start points flushed)`);
  }

  function endTrip(now) {
    // Mirrors the hasLastRecorded guard: no trustworthy position, no end marker. The phone
    // rests where the trip ended: that is the next rest circle's centre.
    if (hasLastRecorded) { endPoint = lastRecordedPos; gate.anchorAt(at(lastRecordedPos), now); } else gate.clear();
    events.push(`${fmt(now)} END (no movement for ${((now - lastMovedMs) / 60000).toFixed(1)}m)`);
    tripId = null;
    hasLastRecorded = false;
    lastMovedMs = 0;
    hasStopAnchor = false;
    stopAnchorTime = 0;
    anchorMaxDoppler = -1;
    confineWindow = [];
    buffer = [];
  }

  /** One GPS fix. `still` = AR's STILL flag; `activity` = 'vehicle' | 'foot' | null. */
  function processFix(now, {
    pos, accuracy, speedKmh, still, activity, vehicleConfirmed = false,
    gaitUsable = true, runningOnFoot = false, arSaysVehicle = false, hasSpeed = true,
  }) {
    // The receiver's own Doppler reading; null on handsets that report none (see dopplerKmh).
    const doppler = hasSpeed ? speedKmh : null;
    if (arSaysVehicle) arSaysVehicleAt = now;
    // Transition semantics: the receiver writes lastActivity when a movement verdict LANDS,
    // i.e. when it changes to a non-null kind.
    if (activity && activity !== prevSeenActivity) {
      lastActivity = activity;
      lastActivityAt = now;
    }
    prevSeenActivity = activity;

    // Inside a trip the accuracy bar is tighter: a fix that could be anywhere in a 96 m circle
    // is not fit to be the anchor the NEXT fix's movement is measured from. See
    // TRIP_ACTIVE_MAX_ACCURACY_M — this is what stopped one bad fix inventing 72 m of travel.
    if (accuracy > (tripId === null ? MAX_ACCURACY_M : TRIP_ACTIVE_MAX_ACCURACY_M)) return;

    if (tripId === null) {
      if (accuracy > TRIP_START_MAX_ACCURACY_M) return;

      // Remember the idle path (spacing-gated so a parked phone appends nothing).
      const lastBuf = buffer[buffer.length - 1];
      if (!lastBuf || Math.abs(pos - lastBuf.pos) >= PRE_START_BUFFER_SPACING_M) {
        buffer.push({ now, pos, accuracy });
        while (buffer.length > PRE_START_BUFFER_MAX) buffer.shift();
        while (buffer.length && now - buffer[0].now > PRE_START_BUFFER_MS) buffer.shift();
      }

      const footRecently = lastActivity === 'foot' && now - lastActivityAt < FOOT_VETO_MS;
      // Live confidence from the continuous activity feed, NOT a transition edge that could be
      // ten minutes old. See ACTIVITY_FRESH_MS in TrackingService.kt: the stale form let a
      // driver who had just parked and walked off open the slow gate on foot.
      const activitySaysVehicle = arSaysVehicleAt !== null && now - arSaysVehicleAt <= ACTIVITY_FRESH_MS;
      const decision = gate.onFix({
        now, pos: at(pos), accuracyM: accuracy, dopplerKmh: doppler, recentKmh: speedKmh,
        vehicleConfirmed, activitySaysVehicle, footRecently, gaitUsable, runningOnFoot,
      });
      const gateName = decision === Decision.START_FAST ? 'fast'
        : decision === Decision.START_SLOW ? 'slow'
        : decision === Decision.START_VEHICLE ? 'vehicle' : null;
      if (gateName) startTrip(now, pos, gateName, doppler);
      return;
    }

    if (!hasLastRecorded) {
      lastRecordedPos = pos;
      lastRecordedAtMs = now;
      hasLastRecorded = true;
      lastMovedMs = now;
      setStopAnchor(now, pos, doppler);
      confineWindow = [];
      return;
    }
    if (doppler !== null && doppler >= DOPPLER_CONFIRM_KMH) tripDopplerMovingFixes++;

    // ── Stop clock ──────────────────────────────────────────────────────────────────────
    // What keeps a trip alive is TRAVEL, not points: recorded points used to refresh
    // lastMovedMs, so a parked phone whose fixes wobbled past the record threshold restarted
    // the end timer indefinitely. Net displacement from a FIXED anchor separates bounded drift
    // from unbounded creep. Doppler speed counts only when the position agrees — a stationary
    // receiver does invent a few km/h out of nothing.
    const netFromStopAnchor = hasStopAnchor ? Math.abs(pos - stopAnchorPos) : Infinity;
    // Vetoes: a Doppler-contradicted JUMP, and CONFINEMENT — see TrackingService.kt.
    confineWindow.push({ now, pos, doppler });
    while (confineWindow.length && now - confineWindow[0].now > CONFINE_WINDOW_MS) confineWindow.shift();
    // Lifted by Play Services' live "in vehicle", NOT by the classifier's verdict — its
    // ground-speed rule reads a wandering fix on a still phone as a creeping vehicle.
    const vehicleNow = arSaysVehicleAt !== null && now - arSaysVehicleAt <= ACTIVITY_FRESH_MS;
    const confined = VETOES && !vehicleNow && isConfined(now);
    if (doppler !== null) anchorMaxDoppler = Math.max(anchorMaxDoppler, doppler);
    const sinceAnchorSec = Math.max(1, (now - stopAnchorTime) / 1000);
    const impliedKmh = (netFromStopAnchor / sinceAnchorSec) * 3.6;
    const gpsJump = VETOES && !vehicleNow && tripDopplerMovingFixes >= DOPPLER_CREDIBLE_FIXES &&
      anchorMaxDoppler >= 0 && anchorMaxDoppler < JUMP_DOPPLER_MAX_KMH &&
      impliedKmh >= JUMP_IMPLIED_KMH;
    const travelled = !confined && !gpsJump && netFromStopAnchor >= Math.max(STOP_CLOCK_MOVE_M, accuracy * 2);
    const corroboratedSpeed = !confined && speedKmh >= RECORD_MOVING_SPEED_KMH && netFromStopAnchor >= accuracy;
    if (travelled || corroboratedSpeed) {
      lastMovedMs = now;
      setStopAnchor(now, pos, doppler);
    }

    const distFromLast = Math.abs(pos - lastRecordedPos);
    const displacementMoving = distFromLast >= Math.max(POINT_DISTANCE_M, accuracy * 1.5);
    // Fourth witness — see the record gate in TrackingService.kt. Below ~2 km/h with AR
    // reporting STILL, this is the only thing keeping recorded points close enough together to
    // survive the server's 45 s map-match split.
    // (`!still` used to be a witness too; the service dropped it — "not known to be still" is
    // not evidence of movement, and it minted a jitter point every 8 s on a parked vehicle.)
    const moving =
      displacementMoving ||
      speedKmh >= RECORD_MOVING_SPEED_KMH ||
      (vehicleConfirmed && speedKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH);
    const dtMs = lastRecordedAtMs > 0 ? now - lastRecordedAtMs : Number.MAX_SAFE_INTEGER;
    const distTrigger = distFromLast >= POINT_DISTANCE_M;
    const timeTrigger =
      dtMs >= RECORD_MIN_INTERVAL_MS && distFromLast >= Math.max(RECORD_MIN_MOVE_M, accuracy * 0.5);
    // Confined: the phone has circled one spot for five minutes — what passes now is jitter.
    if (moving && !(VETOES && confined) && (distTrigger || timeTrigger)) {
      const dtSec = Math.max(1, dtMs) / 1000;
      if ((distFromLast / dtSec) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) return;
      lastRecordedPos = pos;
      lastRecordedAtMs = now;
      // No lastMovedMs here: the stop clock above owns it, and it wants evidence of travel
      // rather than evidence that a point was written.
      points.push({ now, pos });
    }
  }

  function tick(now) {
    if (tripId === null) return;
    if (lastMovedMs > 0 && now - lastMovedMs >= tripEndAfterMs) endTrip(now);
  }

  return {
    processFix,
    tick,
    get tripId() { return tripId; },
    get points() { return points; },
    get endPoint() { return endPoint; },
    events,
    // test hook: pretend a START_STICKY restart restored a trip with no fix seen yet.
    // lastMovedMs must be non-zero — 0 is the engine's "unset" sentinel, while the real service
    // always restores it to a live epoch timestamp (System.currentTimeMillis()).
    restoreTrip(now) { tripId = 'restored'; hasLastRecorded = false; lastMovedMs = Math.max(1, now); },
  };
}

// Deterministic pseudo-noise so runs are reproducible (no Math.random).
const drift = (i, amp) => amp * Math.sin(i * 1.7) * Math.cos(i * 0.9);

/**
 * Phases: { from, to, speedKmh, still, activity, accuracy, driftAmpM, speedNoise }.
 * Position integrates speedKmh over time; parked phases hold position and add drift jitter.
 */
function run(name, { phases, durationMs, gpsSilentAfter = Infinity, setup, assertFn, tripEndAfterMs }) {
  const e = makeEngine(tripEndAfterMs ?? TRIP_END_NO_MOVE_MS);
  if (setup) setup(e);
  let pos = 0;
  let i = 0;
  for (let now = 0; now <= durationMs; now += FIX_INTERVAL_MS, i++) {
    const phase = phases.find((p) => now >= p.from && now < p.to);
    const speed = phase?.speedKmh ?? 0;
    pos += (speed / 3.6) * (FIX_INTERVAL_MS / 1000);
    if (now < gpsSilentAfter && phase) {
      const jitter = phase.driftAmpM ? drift(i, phase.driftAmpM) : 0;
      const speedNoise = phase.speedNoise ? Math.abs(drift(i, phase.speedNoise)) : 0;
      e.processFix(now, {
        pos: pos + jitter,
        accuracy: phase.accuracy ?? 10,
        speedKmh: speed + speedNoise,
        still: phase.still ?? false,
        activity: phase.activity ?? null,
        vehicleConfirmed: phase.vehicleConfirmed ?? false,
        arSaysVehicle: phase.arSaysVehicle ?? false,
        gaitUsable: phase.gaitUsable ?? true,
        runningOnFoot: phase.runningOnFoot ?? false,
      });
    }
    if (now % TICK_INTERVAL_MS === 0) e.tick(now);
  }
  const ok = assertFn(e);
  console.log(`\n=== ${name} ===`);
  e.events.forEach((x) => console.log('  ' + x));
  console.log(`  points recorded: ${e.points.length}`);
  console.log(`  RESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  return ok;
}

const starts = (e) => e.events.filter((x) => x.includes('START')).length;
const ends = (e) => e.events.filter((x) => x.includes('END')).length;
/** Wall time of the END event, in ms — the number the driver compares against their own watch. */
const endAtMs = (e) => {
  const ev = e.events.find((x) => x.includes('END'));
  if (!ev) return null;
  const [m, s] = ev.slice(0, 5).split(':').map(Number);
  return (m * 60 + s) * 1000;
};

let all = true;

all &= run('1. Normal drive 3 min, park 12 min — ends once, ~10 min after stopping', {
  durationMs: 16 * 60 * 1000,
  phases: [{ from: 0, to: 3 * 60_000, speedKmh: 40, activity: 'vehicle' },
           { from: 3 * 60_000, to: 16 * 60_000, speedKmh: 0, still: true, activity: 'vehicle' }],
  assertFn: (e) => {
    const end = e.events.find((x) => x.includes('END'));
    return starts(e) === 1 && ends(e) === 1 && !!end && /10\.\dm/.test(end) && e.endPoint !== null && e.endPoint > 0;
  },
});

all &= run('2. Red light 2.5 min mid-drive — trip must NOT end', {
  durationMs: 10 * 60 * 1000,
  phases: [{ from: 0, to: 2 * 60_000, speedKmh: 40, activity: 'vehicle' },
           { from: 2 * 60_000, to: 4.5 * 60_000, speedKmh: 0, still: true, activity: 'vehicle' },
           { from: 4.5 * 60_000, to: 10 * 60_000, speedKmh: 40, activity: 'vehicle' }],
  assertFn: (e) => starts(e) === 1 && ends(e) === 0 && e.tripId !== null,
});

all &= run('3. THE BUFFER: complete stop 9 min, then drive again — SAME trip continues', {
  durationMs: 15 * 60 * 1000,
  phases: [{ from: 0, to: 2 * 60_000, speedKmh: 40, activity: 'vehicle' },
           { from: 2 * 60_000, to: 11 * 60_000, speedKmh: 0, still: true, activity: 'vehicle' },
           { from: 11 * 60_000, to: 15 * 60_000, speedKmh: 40, activity: 'vehicle' }],
  assertFn: (e) => starts(e) === 1 && ends(e) === 0 && e.tripId !== null,
});

all &= run('4. Jam crawl 2 km/h for 20 min, AR says STILL and Doppler ~0 — dense points, no false end', {
  durationMs: 22 * 60 * 1000,
  phases: [{ from: 0, to: 60_000, speedKmh: 40, activity: 'vehicle' },
           // The killer case: both movement witnesses lie ("still" + 0 km/h), only displacement tells the truth.
           { from: 60_000, to: 22 * 60_000, speedKmh: 2, still: true, activity: 'vehicle', accuracy: 8 }],
  assertFn: (e) => {
    const crawlPoints = e.points.filter((p) => p.now >= 60_000).length;
    return starts(e) === 1 && ends(e) === 0 && e.tripId !== null && crawlPoints >= 30;
  },
});

// `arSaysVehicle` is what a REAL creeping vehicle produces: Play Services' continuous feed
// reporting IN_VEHICLE right now. It used to be enough for these scenarios to carry only a
// transition edge (`activity: 'vehicle'`), but that verdict survives ten minutes past the driver
// parking and walking away — which is how a 2-3 km/h walk was opening the slow gate in the
// field. Scenario 17 now holds that negative case; these two keep testing the slow gate itself.
all &= run('5. Slow start: creep from rest at 4 km/h in vehicle context — trip starts on leaving the 150 m circle', {
  durationMs: 5 * 60 * 1000,
  phases: [{ from: 0, to: 5 * 60_000, speedKmh: 4, still: false, activity: 'vehicle',
             arSaysVehicle: true }],
  assertFn: (e) => {
    const start = e.events.find((x) => x.includes('START'));
    return !!start && start.includes('slow') && starts(e) === 1 && e.points.length > 5;
  },
});

all &= run('6. Walking 4.5 km/h for 7 min (fresh foot verdict) — must NOT start a trip', {
  durationMs: 7 * 60 * 1000,
  phases: [{ from: 0, to: 7 * 60_000, speedKmh: 4.5, still: false, activity: 'foot' }],
  assertFn: (e) => starts(e) === 0 && e.tripId === null,
});

all &= run('7. Parked, no AR, noisy fixes (±8 m drift, ±5 km/h phantom speed, 25 m accuracy) — no jitter points, ends on time', {
  durationMs: 14 * 60 * 1000,
  phases: [{ from: 0, to: 2 * 60_000, speedKmh: 40, activity: 'vehicle' },
           { from: 2 * 60_000, to: 14 * 60_000, speedKmh: 0, still: false, activity: 'vehicle',
             accuracy: 25, driftAmpM: 8, speedNoise: 5 }],
  assertFn: (e) => {
    const parkedPoints = e.points.filter((p) => p.now >= 2 * 60_000 + 10_000).length;
    const end = e.events.find((x) => x.includes('END'));
    return ends(e) === 1 && parkedPoints <= 1 && !!end && /10\.\dm/.test(end);
  },
});

all &= run('8. Restart mid-trip, GPS never returns — trip ends WITHOUT a (0,0) end marker', {
  durationMs: 12 * 60 * 1000,
  phases: [],
  setup: (e) => e.restoreTrip(0),
  assertFn: (e) => ends(e) === 1 && e.endPoint === null,
});

all &= run('9. Slow movement with NO vehicle evidence — must not start', {
  durationMs: 5 * 60 * 1000,
  phases: [{ from: 0, to: 5 * 60_000, speedKmh: 4, still: false, activity: null }],
  assertFn: (e) => starts(e) === 0,
});

all &= run('10. PRE-START CAPTURE: 3 km/h creep — the approach before the gate fires is recovered', {
  durationMs: 6 * 60 * 1000,
  phases: [{ from: 0, to: 6 * 60_000, speedKmh: 3, still: false, activity: 'vehicle',
             arSaysVehicle: true }],
  assertFn: (e) => {
    if (starts(e) !== 1) return false;
    // 150 m at 3 km/h = 3 min before the gate fires. The flushed buffer must reach back to
    // where the creep began — the last fix within 20 m of the rest anchor, which itself
    // settled a few metres into the creep — and cover the ground in between.
    const first = e.points[0];
    const startEvt = e.events.find((x) => x.includes('START'));
    const preStart = e.points.filter((p) => p.pos < 150).length;
    console.log(`  route begins ${first.pos.toFixed(0)} m into the creep, ${preStart} points inside the circle`);
    return !!first && first.pos <= 25 && preStart >= 10 && /\d+ pre-start points flushed/.test(startEvt) && !/\(slow, 0 /.test(startEvt);
  },
});

all &= run('11. STALE foot verdict: brief walk, 12 min parked, then 4 km/h creep — trip starts', {
  durationMs: 18 * 60 * 1000,
  phases: [{ from: 0, to: 60_000, speedKmh: 4.5, still: false, activity: 'foot' },
           { from: 60_000, to: 13 * 60_000, speedKmh: 0, still: true, activity: null },
           { from: 13 * 60_000, to: 18 * 60_000, speedKmh: 4, still: false, activity: null,
             vehicleConfirmed: true }],
  assertFn: (e) => {
    const start = e.events.find((x) => x.includes('START'));
    // The foot verdict is 13+ minutes old by the time the creep accumulates 100 m — stale, so
    // the veto has expired and the slow gate opens.
    return starts(e) === 1 && !!start && (start.includes('slow') || start.includes('vehicle'));
  },
});

all &= run('12. Sensor-confirmed vehicle creeping at 1 km/h - starts on leaving the circle (9 min) and backfills the route from its first metres', {
  durationMs: 12 * 60_000,
  phases: [{
    from: 0, to: 12 * 60_000, speedKmh: 1, accuracy: 8,
    activity: 'vehicle', vehicleConfirmed: true,
  }],
  assertFn: (e) => {
    const first = e.points[0];
    if (first) console.log(`  route begins ${first.pos.toFixed(0)} m into the creep`);
    return starts(e) === 1 && e.tripId !== null && e.points.length >= 12 && first.pos <= 25;
  },
});

all &= run('13. One km/h movement without vehicle confirmation - vehicle gate stays closed', {
  durationMs: 4 * 60_000,
  phases: [{
    from: 0, to: 4 * 60_000, speedKmh: 1, accuracy: 8,
    activity: 'foot', vehicleConfirmed: false,
  }],
  assertFn: (e) => starts(e) === 0 && e.tripId === null,
});

all &= run('14. Runner at 11 km/h with gait evidence - fast gate stays closed', {
  durationMs: 90_000,
  phases: [{
    from: 0, to: 90_000, speedKmh: 11, accuracy: 8,
    activity: 'foot', gaitUsable: true, runningOnFoot: true,
  }],
  assertFn: (e) => starts(e) === 0,
});

all &= run('15. Ambiguous 11 km/h with no gait sensor or vehicle evidence - stays closed', {
  durationMs: 90_000,
  phases: [{
    from: 0, to: 90_000, speedKmh: 11, accuracy: 8,
    activity: null, gaitUsable: false, vehicleConfirmed: false,
  }],
  assertFn: (e) => starts(e) === 0,
});

all &= run('16. DENSITY: 1 km/h crawl for 16 min, AR says STILL — every gap, flushed or recorded, must survive the 45 s map-match split', {
  durationMs: 16 * 60_000,
  phases: [{
    from: 0, to: 16 * 60_000, speedKmh: 1, accuracy: 12, still: true,
    activity: null, vehicleConfirmed: true,
  }],
  assertFn: (e) => {
    if (starts(e) !== 1) return false;
    // MAP_MATCH_SPLIT_GAP_SECONDS: the backend splits the trace at any gap longer than this and
    // throws away runs left with fewer than two points. A crawl recorded more sparsely than this
    // reaches the server and is then silently dropped by the matcher.
    const SPLIT_MS = 45_000;
    let worst = 0;
    for (let i = 1; i < e.points.length; i++) {
      worst = Math.max(worst, e.points[i].now - e.points[i - 1].now);
    }
    console.log(`  widest gap between recorded points: ${(worst / 1000).toFixed(0)}s (limit ${SPLIT_MS / 1000}s)`);
    return e.points.length >= 8 && worst < SPLIT_MS;
  },
});

all &= run('17. FIELD BUG: park, get out, walk 2.5 km/h — the stale vehicle verdict must not open the slow gate', {
  durationMs: 10 * 60_000,
  phases: [
    // Still in the vehicle: Play Services is calling it IN_VEHICLE.
    { from: 0, to: 30_000, speedKmh: 0, still: true, activity: 'vehicle', arSaysVehicle: true },
    // Parked and walking away. The transition verdict says "vehicle" for another ten minutes,
    // but the live feed has stopped saying so and the sensors do not confirm one.
    { from: 30_000, to: 10 * 60_000, speedKmh: 2.5, still: false, activity: null,
      vehicleConfirmed: false, arSaysVehicle: false },
  ],
  assertFn: (e) => starts(e) === 0 && e.tripId === null,
});

all &= run('18. Walking 3 km/h for 10 min with no vehicle evidence of any kind — no trip, ever', {
  durationMs: 10 * 60_000,
  phases: [{ from: 0, to: 10 * 60_000, speedKmh: 3, still: false, activity: null,
             vehicleConfirmed: false, gaitUsable: true }],
  assertFn: (e) => starts(e) === 0 && e.tripId === null,
});

// ── Stop clock: the 2026-09-21 field case, and the per-project timeout ───────────────────────

all &= run('19. FIELD BUG (trip 6ab0cc5b): park at 3:00, ±12 m drift for 15 min — ends 10 min after the REAL stop, not 20', {
  durationMs: 18 * 60 * 1000,
  phases: [{ from: 0, to: 3 * 60_000, speedKmh: 30, activity: 'vehicle' },
           // Exactly what the handset saw: parked, 0 km/h, good-looking 9 m fixes wandering by
           // 10-12 m. Every one of those wobbles used to be a recorded point, and every recorded
           // point used to restart the 10-minute clock.
           { from: 3 * 60_000, to: 18 * 60_000, speedKmh: 0, still: false, activity: 'vehicle',
             accuracy: 9, driftAmpM: 12 }],
  assertFn: (e) => {
    const end = e.events.find((x) => x.includes('END'));
    const at = endAtMs(e);
    console.log(`  ended at ${at !== null ? (at / 60000).toFixed(1) : '—'} min (stop was at 3.0 min)`);
    return ends(e) === 1 && !!end && /10\.\dm/.test(end) && at >= 12.8 * 60_000 && at <= 13.4 * 60_000;
  },
});

all &= run('20. PROJECT OVERRIDE 3 min: same park — trip ends 3 min after stopping', {
  durationMs: 12 * 60 * 1000,
  tripEndAfterMs: 3 * 60 * 1000,
  phases: [{ from: 0, to: 3 * 60_000, speedKmh: 30, activity: 'vehicle' },
           { from: 3 * 60_000, to: 12 * 60_000, speedKmh: 0, still: false, activity: 'vehicle',
             accuracy: 9, driftAmpM: 12 }],
  assertFn: (e) => {
    const end = e.events.find((x) => x.includes('END'));
    const at = endAtMs(e);
    console.log(`  ended at ${at !== null ? (at / 60000).toFixed(1) : '—'} min (stop was at 3.0 min)`);
    return ends(e) === 1 && !!end && /3\.\dm/.test(end) && at >= 5.8 * 60_000 && at <= 6.4 * 60_000;
  },
});

all &= run('21. PROJECT OVERRIDE 3 min: 2.5 min traffic signal mid-drive — trip must still NOT split', {
  durationMs: 10 * 60 * 1000,
  tripEndAfterMs: 3 * 60 * 1000,
  phases: [{ from: 0, to: 2 * 60_000, speedKmh: 40, activity: 'vehicle' },
           { from: 2 * 60_000, to: 4.5 * 60_000, speedKmh: 0, still: true, activity: 'vehicle' },
           { from: 4.5 * 60_000, to: 10 * 60_000, speedKmh: 40, activity: 'vehicle' }],
  assertFn: (e) => starts(e) === 1 && ends(e) === 0 && e.tripId !== null,
});

all &= run('22. The 96 m fix: one junk fix 72 m off a parked car must not invent travel', {
  durationMs: 16 * 60 * 1000,
  // Ordered deliberately: `phases.find` takes the FIRST match, so the junk window overrides the
  // parked phase it sits inside.
  phases: [{ from: 4 * 60_000, to: 4 * 60_000 + 10_000, speedKmh: 0, still: false,
             activity: 'vehicle', accuracy: 96, driftAmpM: 72 },
           { from: 0, to: 2 * 60_000, speedKmh: 30, activity: 'vehicle' },
           { from: 2 * 60_000, to: 16 * 60_000, speedKmh: 0, still: false, activity: 'vehicle',
             accuracy: 9, driftAmpM: 12 }],
  assertFn: (e) => {
    const parkedPos = (30 / 3.6) * 120; // where the car actually stopped, in metres
    const worst = e.points
      .filter((p) => p.now >= 2 * 60_000)
      .reduce((m, p) => Math.max(m, Math.abs(p.pos - parkedPos)), 0);
    const at = endAtMs(e);
    console.log(`  furthest parked point from the real position: ${worst.toFixed(0)} m`);
    console.log(`  ended at ${at !== null ? (at / 60000).toFixed(1) : '—'} min (stop was at 2.0 min)`);
    return ends(e) === 1 && worst <= 30 && at >= 11.8 * 60_000 && at <= 12.4 * 60_000;
  },
});

// ── GPS jumps on a phone that never moved: the 2026-10-01 field case (trip 6abe7d98) ─────────────
//
// What the handset actually recorded after "starting a trip" on a desk: time (s), distance from
// the first fix (m), Doppler (km/h), reported accuracy (m). Every position within 38 m, Doppler ~0
// throughout but for one 24.7 km/h spike that arrived WITH a 36 m jump.
const FIELD_JITTER = [
  [0, 0, 0, 11.9], [22, 31.1, 0, 4.1], [32, 30.2, 1.85, 9.1], [41, 7.9, 0.39, 14.1],
  [49, 19.1, 0.29, 10.1], [61, 23.9, 0.72, 7.1], [73, 28.1, 0.34, 5.1], [83, 34.8, 0, 3.8],
  [126, 21.9, 0, 5.1], [167, 14.7, 0, 6], [187, 8.4, 0.12, 7.9], [227, 19.2, 0, 1.7],
  [307, 28.6, 0, 2.1], [344, 37.3, 4.3, 3.4], [356, 3.1, 24.7, 11.5], [364, 37.9, 0, 4],
  [401, 37.5, 0.22, 5.1],
];
const CYCLE_S = 410;

/**
 * Feed an explicit fix list. Between listed fixes the receiver keeps reporting the last position
 * every FIX_INTERVAL_MS — but with a STILL Doppler reading (0): a speed spike is one fix's reading,
 * not something the receiver repeats for as long as the position happens to hold.
 * `fixes`: [{ t (ms), pos, doppler, accuracy, hasSpeed?, vehicleConfirmed?, gaitUsable? }].
 */
function replay(name, { fixes, durationMs, assertFn }) {
  const e = makeEngine(TRIP_END_NO_MOVE_MS);
  let k = 0;
  let cur = fixes[0];
  for (let now = 0; now <= durationMs; now += FIX_INTERVAL_MS) {
    let fresh = false;
    while (k < fixes.length && fixes[k].t <= now) { cur = fixes[k++]; fresh = true; }
    if (cur && cur.t <= now) {
      e.processFix(now, {
        pos: cur.pos, accuracy: cur.accuracy ?? 8, speedKmh: fresh ? (cur.doppler ?? 0) : (cur.holdDoppler ?? 0),
        still: false, activity: null, hasSpeed: cur.hasSpeed ?? true,
        vehicleConfirmed: cur.vehicleConfirmed ?? false, gaitUsable: cur.gaitUsable ?? true,
      });
    }
    if (now % TICK_INTERVAL_MS === 0) e.tick(now);
  }
  const ok = assertFn(e);
  console.log(`\n=== ${name} ===`);
  e.events.forEach((x) => console.log('  ' + x));
  console.log(`  points recorded: ${e.points.length}`);
  console.log(`  RESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  return ok;
}

/** The field jitter, repeated from `fromS` for `cycles` cycles, centred on `at` metres. */
function fieldJitter(fromS, cycles, at = 0, extra = {}) {
  const out = [];
  for (let c = 0; c < cycles; c++) {
    for (const [t, d, dop, acc] of FIELD_JITTER) {
      out.push({ t: (fromS + c * CYCLE_S + t) * 1000, pos: at + d, doppler: dop, accuracy: acc, ...extra });
    }
  }
  return out;
}

all &= replay('23. FIELD BUG (trip 6abe7d98): log in on a desk — a 35 m warm-up jump in 4 s at 0 km/h Doppler, then 20 min of the recorded jitter — NO trip', {
  durationMs: 21 * 60_000,
  // The login moment: GPS converging, a fix lands 35 m off four seconds after the first.
  fixes: [{ t: 0, pos: 0, doppler: 0, accuracy: 12 }, { t: 4_000, pos: 35, doppler: 0, accuracy: 6 },
          ...fieldJitter(10, 3)],
  assertFn: (e) => starts(e) === 0 && e.tripId === null,
});

all &= replay('24. FIELD BUG: a real trip parks, then the same jitter for 25 min — the trip ENDS (it used to run on forever)', {
  durationMs: 28 * 60_000,
  fixes: [
    // 3 min at 30 km/h with Doppler, then parked at 1500 m with the recorded jitter.
    ...Array.from({ length: 90 }, (_, i) => ({ t: i * 2000, pos: (30 / 3.6) * i * 2, doppler: 30, accuracy: 6 })),
    ...fieldJitter(180, 4, 1500),
  ],
  assertFn: (e) => {
    const at = endAtMs(e);
    console.log(`  ended at ${at !== null ? (at / 60000).toFixed(1) : '—'} min (parked at 3.0 min)`);
    return starts(e) === 1 && ends(e) === 1 && at !== null && at <= 3 * 60_000 + 16 * 60_000;
  },
});

all &= replay('25. Depot: 7 min of the field jitter, then a real pull-away at 30 km/h — trip starts, route covers the pull-away', {
  durationMs: 9 * 60_000,
  // The pull-away begins after the recorded jitter ends (the list is fed in order).
  fixes: [
    ...fieldJitter(0, 1),
    ...Array.from({ length: 60 }, (_, i) => ({ t: 420_000 + i * 2000, pos: 40 + (30 / 3.6) * i * 2, doppler: 30, accuracy: 6 })),
  ],
  assertFn: (e) => {
    // The gate only fires once the vehicle is 150 m out — the pre-start buffer is what makes
    // that harmless: the recorded route must still begin within seconds of the real pull-away,
    // and must NOT reach back into the seven minutes of jitter before it.
    const firstPt = e.points[0];
    console.log(`  route begins ${((420_000 - firstPt.now) / 1000).toFixed(0)} s before the pull-away`);
    if (420_000 - firstPt.now > 60_000) return false;
    const firstDriven = e.points.find((pt) => pt.now >= 420_000);
    console.log(`  first recorded point after pull-away: ${firstDriven ? ((firstDriven.now - 420_000) / 1000).toFixed(0) + ' s' : '—'}`);
    return starts(e) === 1 && !!firstDriven && firstDriven.now - 420_000 <= 10_000;
  },
});

all &= replay('26. Handset with NO Doppler at all: a real pull-away still starts the trip', {
  durationMs: 3 * 60_000,
  fixes: Array.from({ length: 90 }, (_, i) => ({ t: i * 2000, pos: (30 / 3.6) * i * 2, doppler: 30, hasSpeed: false, accuracy: 6 })),
  assertFn: (e) => starts(e) === 1,
});

all &= replay('27. Jam crawl at 2 km/h with Doppler reading ZERO and no sensor verdict — the trip must NOT end', {
  durationMs: 20 * 60_000,
  fixes: [
    ...Array.from({ length: 30 }, (_, i) => ({ t: i * 2000, pos: (30 / 3.6) * i * 2, doppler: 30, accuracy: 6 })),
    // 2 km/h of real creep from 500 m, with a receiver that reports 0 km/h throughout.
    ...Array.from({ length: 570 }, (_, i) => ({ t: 60_000 + i * 2000, pos: 500 + (2 / 3.6) * i * 2, doppler: 0, accuracy: 6 })),
  ],
  assertFn: (e) => starts(e) === 1 && ends(e) === 0 && e.tripId !== null,
});

all &= replay('28. A trip ends; the phone then sits in the field jitter for 40 min, with a 24.7 km/h speed spike every cycle — NO second trip', {
  durationMs: 55 * 60_000,
  fixes: [
    ...Array.from({ length: 90 }, (_, i) => ({ t: i * 2000, pos: (30 / 3.6) * i * 2, doppler: 30, accuracy: 6 })),
    ...fieldJitter(180, 7, 1500),
  ],
  assertFn: (e) => starts(e) === 1 && ends(e) === 1 && e.tripId === null,
});

all &= replay('29. The same parked phone, and the classifier wrongly says VEHICLE throughout (its ground-speed rule, fed by the jitter) — still no second trip, and the first one still ends', {
  durationMs: 55 * 60_000,
  fixes: [
    ...Array.from({ length: 90 }, (_, i) => ({ t: i * 2000, pos: (30 / 3.6) * i * 2, doppler: 30, accuracy: 6 })),
    ...fieldJitter(180, 7, 1500, { vehicleConfirmed: true }),
  ],
  assertFn: (e) => {
    const at = endAtMs(e);
    console.log(`  ended at ${at !== null ? (at / 60000).toFixed(1) : '—'} min (parked at 3.0 min)`);
    return starts(e) === 1 && ends(e) === 1 && e.tripId === null && at !== null && at <= 3 * 60_000 + 16 * 60_000;
  },
});

console.log(`\n${all ? 'ALL VEHICLE-GATE SCENARIOS PASS' : 'SOME VEHICLE-GATE SCENARIOS FAILED'}`);
process.exit(all ? 0 : 1);
