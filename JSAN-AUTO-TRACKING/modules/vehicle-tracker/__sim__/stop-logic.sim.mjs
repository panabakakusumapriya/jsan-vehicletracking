/**
 * Deterministic simulation of TrackingService's trip-start / record / trip-end decision logic.
 * NOT the device runtime — it mirrors the exact constants + decision rules from
 * TrackingService.kt (the DISTANCE-BASED design; the old speed-averaging engine this file used
 * to model is retired) so the algorithm can be proven without a phone. Runtime-only concerns
 * (Doze, whether the fused provider actually stops emitting) still need on-device verification.
 *
 * Position is modelled as a 1-D scalar in METRES from an origin; "distance" is abs difference.
 *
 * Run: node modules/vehicle-tracker/__sim__/stop-logic.sim.mjs
 */

// ── Constants (must match TrackingService.kt) ──
const TRIP_START_DISTANCE_M = 30;
const TRIP_START_MIN_SPEED_KMH = 10.0;
const TRIP_START_SLOW_DISTANCE_M = 100;
const TRIP_START_SLOW_MIN_SPEED_KMH = 2.0;
const TRIP_START_VEHICLE_DISTANCE_M = 20;
const TRIP_START_VEHICLE_MIN_SPEED_KMH = 0.8;
const TRIP_START_VEHICLE_MAX_ACCURACY_M = 25;
const TRIP_START_MAX_ACCURACY_M = 50;
const FOOT_VETO_MS = 10 * 60 * 1000;
const ACTIVITY_FRESH_MS = 90_000;
const PRE_START_BUFFER_MS = 5 * 60 * 1000;
const PRE_START_BUFFER_MAX = 240;
const PRE_START_BUFFER_SPACING_M = 5;
const POINT_DISTANCE_M = 10;
const RECORD_MIN_INTERVAL_MS = 8_000;
const RECORD_MIN_MOVE_M = 3;
const RECORD_MOVING_SPEED_KMH = 3.0;
const MAX_PLAUSIBLE_SPEED_KMH = 180.0;
const TRIP_END_NO_MOVE_MS = 10 * 60 * 1000;
const TICK_INTERVAL_MS = 20_000;
const MAX_ACCURACY_M = 100;
const FIX_INTERVAL_MS = 2_000;

function makeEngine() {
  let tripId = null;
  let startWatchPos = null;
  let startWatchTime = 0;
  let lastRecordedPos = 0;
  let lastRecordedAtMs = 0;
  let hasLastRecorded = false;
  let lastMovedMs = 0;
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

  function startTrip(now, pos, gate) {
    tripId = `T${now}`;
    // Flush the buffered approach BEFORE the start point — original timestamps, so the trip
    // begins where the movement began, not where the gate finally recognised it.
    let flushed = 0;
    for (const b of buffer) {
      if (b.now < startWatchTime || b.now >= now) continue;
      points.push({ now: b.now, pos: b.pos });
      flushed++;
    }
    buffer = [];
    lastRecordedPos = pos;
    lastRecordedAtMs = now;
    hasLastRecorded = true;
    lastMovedMs = now;
    startWatchPos = null;
    points.push({ now, pos });
    events.push(`${fmt(now)} START (${gate}, ${flushed} pre-start points flushed)`);
  }

  function endTrip(now) {
    // Mirrors the hasLastRecorded guard: no trustworthy position, no end marker.
    if (hasLastRecorded) endPoint = lastRecordedPos;
    events.push(`${fmt(now)} END (no movement for ${((now - lastMovedMs) / 60000).toFixed(1)}m)`);
    tripId = null;
    hasLastRecorded = false;
    lastMovedMs = 0;
    startWatchPos = null;
    buffer = [];
  }

  /** One GPS fix. `still` = AR's STILL flag; `activity` = 'vehicle' | 'foot' | null. */
  function processFix(now, {
    pos, accuracy, speedKmh, still, activity, vehicleConfirmed = false,
    gaitUsable = true, runningOnFoot = false, arSaysVehicle = false,
  }) {
    if (arSaysVehicle) arSaysVehicleAt = now;
    // Transition semantics: the receiver writes lastActivity when a movement verdict LANDS,
    // i.e. when it changes to a non-null kind.
    if (activity && activity !== prevSeenActivity) {
      lastActivity = activity;
      lastActivityAt = now;
    }
    prevSeenActivity = activity;

    if (accuracy > MAX_ACCURACY_M) return;

    if (tripId === null) {
      if (accuracy > TRIP_START_MAX_ACCURACY_M) return;

      // Remember the idle path (spacing-gated so a parked phone appends nothing).
      const lastBuf = buffer[buffer.length - 1];
      if (!lastBuf || Math.abs(pos - lastBuf.pos) >= PRE_START_BUFFER_SPACING_M) {
        buffer.push({ now, pos });
        while (buffer.length > PRE_START_BUFFER_MAX) buffer.shift();
        while (buffer.length && now - buffer[0].now > PRE_START_BUFFER_MS) buffer.shift();
      }

      if (startWatchPos === null) {
        startWatchPos = pos;
        startWatchTime = now;
        return;
      }
      const distFromWatch = Math.abs(pos - startWatchPos);
      const speedGateReach = distFromWatch >= Math.max(TRIP_START_DISTANCE_M, accuracy * 1.5);
      const vehicleGateReach = distFromWatch >= Math.max(TRIP_START_VEHICLE_DISTANCE_M, accuracy * 2);
      if (speedGateReach || vehicleGateReach) {
        const elapsedSec = Math.max(0.1, (now - startWatchTime) / 1000);
        const avgSpeedKmh = (distFromWatch / elapsedSec) * 3.6;
        const fastStart = speedGateReach &&
          avgSpeedKmh >= TRIP_START_MIN_SPEED_KMH &&
          (vehicleConfirmed || speedKmh >= 20 || (gaitUsable && !runningOnFoot));
        const footRecently = lastActivity === 'foot' && now - lastActivityAt < FOOT_VETO_MS;
        // Live confidence from the continuous activity feed, NOT a transition edge that could be
        // ten minutes old. See ACTIVITY_FRESH_MS in TrackingService.kt: the stale form let a
        // driver who had just parked and walked off open the slow gate on foot.
        const activitySaysVehicle = arSaysVehicleAt !== null && now - arSaysVehicleAt <= ACTIVITY_FRESH_MS;
        const slowStart =
          speedGateReach &&
          avgSpeedKmh >= TRIP_START_SLOW_MIN_SPEED_KMH &&
          distFromWatch >= TRIP_START_SLOW_DISTANCE_M &&
          !footRecently && (vehicleConfirmed || activitySaysVehicle);
        const vehicleStart =
          vehicleConfirmed &&
          vehicleGateReach &&
          accuracy <= TRIP_START_VEHICLE_MAX_ACCURACY_M &&
          speedKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH;
        if (fastStart || slowStart || vehicleStart) {
          startTrip(now, pos, fastStart ? 'fast' : slowStart ? 'slow' : 'vehicle');
        } else if (
          speedGateReach &&
          avgSpeedKmh < TRIP_START_SLOW_MIN_SPEED_KMH &&
          !(vehicleConfirmed && speedKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH)
        ) {
          startWatchPos = pos;
          startWatchTime = now;
        }
        // between the gates: keep the watch anchored — a crawl keeps accumulating
      }
      return;
    }

    if (!hasLastRecorded) {
      lastRecordedPos = pos;
      lastRecordedAtMs = now;
      hasLastRecorded = true;
      lastMovedMs = now;
      return;
    }

    const distFromLast = Math.abs(pos - lastRecordedPos);
    const displacementMoving = distFromLast >= Math.max(POINT_DISTANCE_M, accuracy * 1.5);
    // Fourth witness — see the record gate in TrackingService.kt. Below ~2 km/h with AR
    // reporting STILL, this is the only thing keeping recorded points close enough together to
    // survive the server's 45 s map-match split.
    const moving =
      displacementMoving ||
      !still ||
      speedKmh >= RECORD_MOVING_SPEED_KMH ||
      (vehicleConfirmed && speedKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH);
    const dtMs = lastRecordedAtMs > 0 ? now - lastRecordedAtMs : Number.MAX_SAFE_INTEGER;
    const distTrigger = distFromLast >= POINT_DISTANCE_M;
    const timeTrigger =
      dtMs >= RECORD_MIN_INTERVAL_MS && distFromLast >= Math.max(RECORD_MIN_MOVE_M, accuracy * 0.5);
    if (moving && (distTrigger || timeTrigger)) {
      const dtSec = Math.max(1, dtMs) / 1000;
      if ((distFromLast / dtSec) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) return;
      lastRecordedPos = pos;
      lastRecordedAtMs = now;
      lastMovedMs = now;
      points.push({ now, pos });
    }
  }

  function tick(now) {
    if (tripId === null) return;
    if (lastMovedMs > 0 && now - lastMovedMs >= TRIP_END_NO_MOVE_MS) endTrip(now);
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
function run(name, { phases, durationMs, gpsSilentAfter = Infinity, setup, assertFn }) {
  const e = makeEngine();
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
all &= run('5. Slow start: creep from rest at 4 km/h in vehicle context — trip starts by ~100 m', {
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
    // 100 m at 3 km/h = 2 min before the gate fires. The flushed buffer must reach back to
    // roughly when the creep began, and cover most of the pre-start ground.
    const first = e.points[0];
    const startEvt = e.events.find((x) => x.includes('START'));
    const preStart = e.points.filter((p, idx) => idx > 0 && p.now < e.points[e.points.length - 1].now && p.pos < 100).length;
    return !!first && first.now <= 15_000 && preStart >= 10 && /\d+ pre-start points flushed/.test(startEvt) && !/\(slow, 0 /.test(startEvt);
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

all &= run('12. Sensor-confirmed vehicle creeping at 1 km/h - starts and backfills route', {
  durationMs: 4 * 60_000,
  phases: [{
    from: 0, to: 4 * 60_000, speedKmh: 1, accuracy: 8,
    activity: 'vehicle', vehicleConfirmed: true,
  }],
  assertFn: (e) => starts(e) === 1 && e.tripId !== null && e.points.length >= 4,
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

all &= run('16. DENSITY: 1 km/h crawl for 8 min, AR says STILL — every gap must survive the 45 s map-match split', {
  durationMs: 8 * 60_000,
  phases: [{
    from: 0, to: 8 * 60_000, speedKmh: 1, accuracy: 12, still: true,
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

console.log(`\n${all ? 'ALL VEHICLE-GATE SCENARIOS PASS' : 'SOME VEHICLE-GATE SCENARIOS FAILED'}`);
process.exit(all ? 0 : 1);
