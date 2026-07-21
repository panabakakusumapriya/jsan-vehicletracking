/**
 * Deterministic simulation of TrackingService's stop-detection decision logic.
 * NOT the device runtime — it mirrors the exact constants + decision rules from
 * TrackingService.kt so we can prove the *algorithm* (start / stop / traffic / GPS-noise /
 * stale) without a phone. Runtime-only concerns (Doze, whether the fused provider actually
 * stops emitting) still require on-device verification.
 *
 * Position is modelled as a 1-D scalar in METRES from an origin; "distance" is abs difference.
 */

// ── Constants (must match TrackingService.kt) ──
const START_SPEED_KMH = 10.0;
const STOP_SPEED_KMH = 3.0;
const STOP_GRACE_MS = 3 * 60 * 1000;
const STILL_STOP_GRACE_MS = 2 * 60 * 1000;
const STATIONARY_HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 60_000;
const TICK_INTERVAL_MS = 20_000;
const STICKY_RADIUS_M = 35;

const shouldEndStop = (elapsed, still) =>
  elapsed >= STOP_GRACE_MS || (still && elapsed >= STILL_STOP_GRACE_MS);

function makeEngine() {
  let tripId = null, stillSince = 0, anchor = null, lastHeartbeat = 0;
  let lastServerRecordedAt = 0, lastPos = null;
  const speedBuf = [];
  const avg = (s) => { if (speedBuf.length >= 3) speedBuf.shift(); speedBuf.push(s); return speedBuf.reduce((a, b) => a + b, 0) / speedBuf.length; };
  const events = [];
  const emittedWhileParked = []; // positions we told the server/map while stopped

  const record = (now) => { lastServerRecordedAt = now; };
  const withinAnchor = (pos) => anchor !== null && Math.abs(pos - anchor) <= STICKY_RADIUS_M;

  function processFix(now, rawSpeed, still, pos) {
    lastPos = pos;
    const avgSpeed = avg(rawSpeed);
    if (tripId === null) {
      if (avgSpeed >= START_SPEED_KMH && !still) {
        tripId = 'T' + now; stillSince = 0; anchor = null; lastHeartbeat = now;
        record(now); events.push(`${fmt(now)} START`);
      }
      return;
    }
    const speedStopped = avgSpeed <= STOP_SPEED_KMH || (still && avgSpeed < START_SPEED_KMH);
    const stopped = speedStopped || withinAnchor(pos);
    if (stopped) {
      if (stillSince === 0) { stillSince = now; lastHeartbeat = 0; }
      if (anchor === null) anchor = pos;
      const elapsed = now - stillSince;
      if (shouldEndStop(elapsed, still)) { endTrip(now); }
      else if (now - lastHeartbeat >= STATIONARY_HEARTBEAT_MS) {
        lastHeartbeat = now; record(now); emittedWhileParked.push(anchor); // FROZEN at anchor
      }
    } else {
      if (stillSince !== 0) stillSince = 0;
      anchor = null; lastHeartbeat = now; record(now);
    }
  }

  function tick(now, still) {
    if (tripId === null) return;
    if (stillSince === 0) {
      if (still && lastPos !== null) { stillSince = now; if (anchor === null) anchor = lastPos; lastHeartbeat = 0; }
      else return;
    }
    if (anchor === null) return;
    const elapsed = now - stillSince;
    if (shouldEndStop(elapsed, still)) { endTrip(now); return; }
    if (now - lastHeartbeat >= STATIONARY_HEARTBEAT_MS) { lastHeartbeat = now; record(now); emittedWhileParked.push(anchor); }
  }

  function endTrip(now) {
    events.push(`${fmt(now)} END (stopped ${((now - stillSince) / 60000).toFixed(1)}m)`);
    tripId = null; stillSince = 0; anchor = null; lastHeartbeat = 0; record(now);
  }

  return {
    processFix, tick, endTrip,
    get tripId() { return tripId; },
    get anchorPos() { return anchor; },
    maxParkedDeviation() { return emittedWhileParked.length ? Math.max(...emittedWhileParked.map((p) => Math.abs(p - emittedWhileParked[0]))) : 0; },
    events,
  };
}

const fmt = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

// Deterministic pseudo-noise so the run is reproducible (no Math.random).
const drift = (i, amp) => amp * Math.sin(i * 1.7) * Math.cos(i * 0.9);

function run(name, { phases, gpsSilentAfter = Infinity, durationMs, assertFn }) {
  const e = makeEngine();
  let i = 0;
  for (let now = 0; now <= durationMs; now += 5000, i++) {
    const phase = phases.find((p) => now >= p.from && now < p.to);
    const baseSpeed = phase ? phase.speed : 0;
    const still = phase ? !!phase.still : true;
    // position advances with real speed; parked phases add drift jitter around a fixed point
    const pos = phase ? (phase.driftAmpM ? phase.posM + drift(i, phase.driftAmpM) : phase.posM ?? 0) : 0;
    const noisySpeed = phase?.driftAmpM ? Math.abs(baseSpeed + drift(i, phase.speedNoise ?? 0)) : baseSpeed;
    if (now % 10000 === 0 && now < gpsSilentAfter) e.processFix(now, noisySpeed, still, pos);
    if (now % TICK_INTERVAL_MS === 0) e.tick(now, still);
  }
  const ok = assertFn(e);
  console.log(`\n=== ${name} ===`);
  e.events.forEach((x) => console.log('  ' + x));
  console.log(`  RESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  return ok;
}

let all = true;

all &= run('1. Drive 2m then park', {
  durationMs: 8 * 60 * 1000,
  phases: [{ from: 0, to: 120_000, speed: 40, posM: 0 }],
  assertFn: (e) => e.events.some((x) => x.includes('START')) && e.events.some((x) => x.includes('END')),
});

all &= run('2. Red light 1m then drive (must NOT end)', {
  durationMs: 6 * 60 * 1000,
  phases: [
    { from: 0, to: 90_000, speed: 40, posM: 0 },
    { from: 90_000, to: 150_000, speed: 0, still: false, posM: 500 },
    { from: 150_000, to: 360_000, speed: 40, posM: 600 },
  ],
  assertFn: (e) => e.events.filter((x) => x.includes('END')).length === 0 && e.tripId !== null,
});

all &= run('3. STILL park ends ~2m', {
  durationMs: 6 * 60 * 1000,
  phases: [{ from: 0, to: 60_000, speed: 40, posM: 0 }, { from: 60_000, to: 360_000, speed: 0, still: true, posM: 300 }],
  assertFn: (e) => { const end = e.events.find((x) => x.includes('END')); return !!end && /stopped 2\.\d/.test(end); },
});

all &= run('4a. Park (STILL), GPS silent 15s later — ticker ends via AR', {
  durationMs: 6 * 60 * 1000, gpsSilentAfter: 75_000,
  phases: [{ from: 0, to: 60_000, speed: 40, posM: 0 }, { from: 60_000, to: 360_000, speed: 0, still: true, posM: 300 }],
  assertFn: (e) => e.events.some((x) => x.includes('END')) && e.tripId === null,
});

all &= run('4b. Park (no AR), GPS keeps delivering — ends normally', {
  durationMs: 6 * 60 * 1000,
  phases: [{ from: 0, to: 60_000, speed: 40, posM: 0 }, { from: 60_000, to: 360_000, speed: 0, still: false, posM: 300 }],
  assertFn: (e) => e.events.some((x) => x.includes('END')) && e.tripId === null,
});

// 5. THE GPS-NOISE CASE: parked, NO Doppler-zero + NO Activity Recognition, drift jitters both
//    position (±15 m) and derived speed (±6 km/h into the 3–10 "residual" band). The sticky
//    radius must keep us stopped, the emitted marker must stay FROZEN at the anchor, and the
//    trip must still end on the 3-min grace (drift must NOT reset the timer).
all &= run('5. Parked + heavy GPS noise (no AR, no Doppler)', {
  durationMs: 7 * 60 * 1000,
  phases: [
    { from: 0, to: 60_000, speed: 40, posM: 0 },
    { from: 60_000, to: 420_000, speed: 5, still: false, posM: 800, driftAmpM: 15, speedNoise: 6 },
  ],
  assertFn: (e) => {
    const ended = e.events.some((x) => x.includes('END'));
    const endEntry = e.events.find((x) => x.includes('END'));
    const endedOnTime = endEntry && /stopped 3\.\d/.test(endEntry); // ~3m, NOT reset by drift
    const frozen = e.maxParkedDeviation() === 0; // every parked emit was the same anchor point
    return ended && endedOnTime && frozen && e.tripId === null;
  },
});

console.log(`\n${all ? 'ALL SCENARIOS PASS ✅' : 'SOME FAILED ❌'}`);
process.exit(all ? 0 : 1);
