/**
 * Deterministic simulation of MotionClassifier's vehicle-vs-foot decision.
 *
 * NOT the device runtime — it is a line-for-line port of the decision rules in
 * MotionClassifier.kt (gait detection from an accelerometer window, then the weighted score that
 * fuses gait, GPS speed, gyroscope and Play Services activity recognition), so the algorithm can
 * be proven against synthetic sensor traces without a phone in a car.
 *
 * What it can prove:  that walking is classified as FOOT and a 1 km/h creep as VEHICLE; that road
 *                     vibration does not read as a gait; how many seconds a verdict takes.
 * What it cannot:     real accelerometer traces, real Play Services behaviour, Doze, sensor
 *                     batching latency. Those still need a phone.
 *
 * Run: node modules/vehicle-tracker/__sim__/motion-classifier.sim.mjs
 */

// ── Constants (must match MotionClassifier.kt) ──
const SAMPLE_HZ = 25; // SAMPLE_PERIOD_US = 40_000
const WINDOW_MS = 6_000;
const MAX_SAMPLES = 200;
const EVAL_INTERVAL_MS = 1_000;

const LOWPASS_HZ = 3.5;
const GAIT_MIN_STD = 0.45;
const GAIT_MAX_STD = 9.0;
const GAIT_BAND_RATIO_MIN = 0.35;
const GAIT_MIN_STEPS = 5;
const WALK_MIN_HZ = 1.1;
const GAIT_MAX_HZ = 3.6;
const RUN_MIN_HZ = 2.4;
const RUN_MIN_STD = 1.3;
const GAIT_MAX_INTERVAL_CV = 0.4;
const PEAK_REFRACTORY_MS = 220;

const SPEED_CERTAIN_VEHICLE_KMH = 20.0;
const SPEED_LIKELY_VEHICLE_KMH = 12.0;
const CREEP_MIN_KMH = 0.7;
const SPEED_WINDOW_MAX = 8;

const GYRO_QUIET_RPS = 0.25;
const GYRO_CARRIED_RPS = 0.6;

const AR_MIN_CONFIDENCE = 50;
const AR_FRESH_MS = 90_000;

const SCORE_CAP = 12.0;
const ENTER_SCORE = 6.0;
const HOLD_SCORE = 2.0;
const SCORE_DECAY = 0.85;

function makeClassifier() {
  /** @type {{mag: number, low: number, t: number}[]} */
  let buf = [];
  let lp1 = 0, lp2 = 0, lastSampleMs = 0;
  let speedWindow = [];
  let gyroRms = 0;
  let sawGyro = false;
  let score = 0;
  let verdict = 'UNKNOWN';
  let gait = 'NONE';
  let accelStd = 0;
  let cadenceHz = 0;
  let lastEvalMs = -Infinity;

  function onAccel(mag, t) {
    // Two-pole low-pass, coefficient from the actual inter-sample gap (see push() in the Kotlin).
    if (lastSampleMs === 0) {
      lp1 = mag;
      lp2 = mag;
    } else {
      const dt = Math.min(200, Math.max(1, t - lastSampleMs)) / 1000;
      const rc = 1 / (2 * Math.PI * LOWPASS_HZ);
      const alpha = dt / (rc + dt);
      lp1 += alpha * (mag - lp1);
      lp2 += alpha * (lp1 - lp2);
    }
    lastSampleMs = t;
    buf.push({ mag, low: lp2, t });
    if (buf.length > MAX_SAMPLES) buf.shift();
    maybeEvaluate(t);
  }

  function onGyro(rps) {
    gyroRms = !sawGyro ? rps : gyroRms * 0.97 + rps * 0.03;
    sawGyro = true;
  }

  function onGpsFix(fixSpeedKmh, groundSpeedKmh) {
    const effective = Math.max(fixSpeedKmh, groundSpeedKmh ?? 0);
    speedWindow.push(Number.isFinite(effective) && effective >= 0 ? effective : 0);
    while (speedWindow.length > SPEED_WINDOW_MAX) speedWindow.shift();
  }

  function sustainedSpeedKmh() {
    if (!speedWindow.length) return 0;
    const sorted = [...speedWindow].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length * 4) / 10)];
  }

  function analyseAccelerometer(now) {
    const win = buf.filter((s) => now - s.t <= WINDOW_MS);
    if (win.length < GAIT_MIN_STEPS * 2) {
      gait = 'NONE';
      accelStd = 0;
      cadenceHz = 0;
      return;
    }
    // Gait statistics run on the LOW-PASSED signal; the raw one only supplies the band ratio.
    const mean = win.reduce((a, s) => a + s.low, 0) / win.length;
    const std = Math.sqrt(win.reduce((a, s) => a + (s.low - mean) ** 2, 0) / win.length);
    const rawMean = win.reduce((a, s) => a + s.mag, 0) / win.length;
    const rawStd = Math.sqrt(win.reduce((a, s) => a + (s.mag - rawMean) ** 2, 0) / win.length);
    const bandRatio = rawStd > 0.01 ? std / rawStd : 0;
    accelStd = std;

    const threshold = Math.max(0.45, std * 0.5);
    const peaks = [];
    let above = false;
    let lastPeak = -Infinity;
    for (const s of win) {
      const d = s.low - mean;
      if (!above && d > threshold) {
        above = true;
        if (s.t - lastPeak >= PEAK_REFRACTORY_MS && peaks.length < 64) {
          peaks.push(s.t);
          lastPeak = s.t;
        }
      } else if (above && d < 0) {
        above = false;
      }
    }
    const spanSec = Math.max(1, win[win.length - 1].t - win[0].t) / 1000;
    cadenceHz = peaks.length / spanSec;

    let cv = Number.MAX_VALUE;
    if (peaks.length >= GAIT_MIN_STEPS) {
      const intervals = peaks.slice(1).map((t, i) => t - peaks[i]);
      const im = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (im > 0) {
        cv = Math.sqrt(intervals.reduce((a, b) => a + (b - im) ** 2, 0) / intervals.length) / im;
      }
    }

    const isGait =
      peaks.length >= GAIT_MIN_STEPS &&
      std >= GAIT_MIN_STD &&
      std <= GAIT_MAX_STD &&
      bandRatio >= GAIT_BAND_RATIO_MIN &&
      cadenceHz >= WALK_MIN_HZ &&
      cadenceHz <= GAIT_MAX_HZ &&
      cv <= GAIT_MAX_INTERVAL_CV;
    gait = isGait ? (cadenceHz >= RUN_MIN_HZ && std >= RUN_MIN_STD ? 'RUN' : 'WALK') : 'NONE';
  }

  // Activity-recognition state, written by the scenario the way the receiver writes prefs.
  let arVehicle = 0;
  let arFoot = 0;
  let arAt = -Infinity;
  function setAr(vehicle, foot, now) {
    arVehicle = vehicle;
    arFoot = foot;
    arAt = now;
  }

  function evaluate(now) {
    analyseAccelerometer(now);
    const speed = sustainedSpeedKmh();
    const haveAccel = buf.length >= GAIT_MIN_STEPS * 2;
    let evidence = 0;

    if (speed >= SPEED_CERTAIN_VEHICLE_KMH) evidence += 4;
    else if (speed >= SPEED_LIKELY_VEHICLE_KMH && gait !== 'RUN') evidence += 2;

    if (gait !== 'NONE') evidence -= 3;

    if (haveAccel && gait === 'NONE' && speed >= CREEP_MIN_KMH && accelStd <= GAIT_MAX_STD) {
      evidence += 2;
    }

    const arAge = now - arAt;
    if (arAge >= 0 && arAge <= AR_FRESH_MS) {
      if (arVehicle >= AR_MIN_CONFIDENCE) evidence += 3;
      if (arFoot >= AR_MIN_CONFIDENCE) evidence -= 3;
    }

    if (sawGyro && gait === 'NONE' && speed >= CREEP_MIN_KMH && gyroRms < GYRO_QUIET_RPS) {
      evidence += 1;
    }
    if (sawGyro && gyroRms >= GYRO_CARRIED_RPS) evidence -= 2;

    score = evidence === 0 ? score * SCORE_DECAY : score + evidence;
    score = Math.min(SCORE_CAP, Math.max(-SCORE_CAP, score));

    verdict =
      score >= ENTER_SCORE
        ? 'VEHICLE'
        : score <= -ENTER_SCORE
          ? 'FOOT'
          : verdict === 'VEHICLE' && score >= HOLD_SCORE
            ? 'VEHICLE'
            : verdict === 'FOOT' && score <= -HOLD_SCORE
              ? 'FOOT'
              : 'UNKNOWN';
  }

  function maybeEvaluate(now) {
    if (now - lastEvalMs < EVAL_INTERVAL_MS) return;
    lastEvalMs = now;
    evaluate(now);
  }

  return {
    onAccel,
    onGyro,
    onGpsFix,
    setAr,
    get verdict() { return verdict; },
    get gait() { return gait; },
    get score() { return score; },
    get accelStd() { return accelStd; },
    get cadenceHz() { return cadenceHz; },
  };
}

// ── Synthetic accelerometer traces (deterministic; no Math.random) ──

/** Human gait: a strong periodic impact at `hz`, with a second harmonic and a little wobble. */
const gaitTrace = (hz, amp) => (t) =>
  9.81 +
  amp * Math.sin(2 * Math.PI * hz * t) +
  amp * 0.35 * Math.sin(2 * Math.PI * hz * 2 * t + 0.7) +
  amp * 0.06 * Math.sin(2 * Math.PI * 0.31 * t);

/**
 * Road vibration: several incommensurate high frequencies. Undersampled at 25 Hz on purpose —
 * that is what the phone really sees, and it is the case most likely to fool a peak counter.
 */
const roadTrace = (amp) => (t) =>
  9.81 +
  amp * Math.sin(2 * Math.PI * 7.3 * t) +
  amp * 0.8 * Math.sin(2 * Math.PI * 11.7 * t + 1.1) +
  amp * 0.6 * Math.sin(2 * Math.PI * 4.9 * t + 2.3) +
  amp * 0.4 * Math.sin(2 * Math.PI * 17.1 * t + 0.4);

/** A phone lying on a seat with the engine running: tiny, fast, structureless. */
const idleTrace = (t) => 9.81 + 0.09 * Math.sin(2 * Math.PI * 21.3 * t) + 0.05 * Math.sin(2 * Math.PI * 13.9 * t);

function run(name, { durationMs, accel, gyroRps, speedKmh, groundKmh, ar, assertFn }) {
  const c = makeClassifier();
  const stepMs = 1000 / SAMPLE_HZ;
  let nextGps = 0;
  let firstVerdictAt = null;

  for (let now = 0; now <= durationMs; now += stepMs) {
    const tSec = now / 1000;
    c.onAccel(accel(tSec), Math.round(now));
    if (gyroRps !== undefined) c.onGyro(typeof gyroRps === 'function' ? gyroRps(tSec) : gyroRps);
    if (now >= nextGps) {
      nextGps += 2000; // LOCATION_INTERVAL_MS while moving
      const s = typeof speedKmh === 'function' ? speedKmh(tSec) : speedKmh;
      const g = groundKmh === undefined ? null : typeof groundKmh === 'function' ? groundKmh(tSec) : groundKmh;
      c.onGpsFix(s, g);
    }
    if (ar) c.setAr(ar.vehicle, ar.foot, Math.round(now));
    if (firstVerdictAt === null && c.verdict !== 'UNKNOWN') firstVerdictAt = now;
  }

  const ok = assertFn(c, firstVerdictAt);
  console.log(`\n=== ${name} ===`);
  console.log(
    `  gait=${c.gait} verdict=${c.verdict} score=${c.score.toFixed(1)} ` +
    `gaitBandStd=${c.accelStd.toFixed(2)} cadence=${c.cadenceHz.toFixed(2)}Hz ` +
    `settled=${firstVerdictAt === null ? 'never' : (firstVerdictAt / 1000).toFixed(0) + 's'}`
  );
  console.log(`  RESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  return ok;
}

let all = true;

all &= run('1. Walking 5 km/h, phone in pocket — FOOT, and no vehicle verdict at any point', {
  durationMs: 30_000,
  accel: gaitTrace(1.8, 2.5),
  gyroRps: 0.9,
  speedKmh: 5,
  assertFn: (c) => c.gait === 'WALK' && c.verdict === 'FOOT',
});

all &= run('2. Running 11 km/h — RUN, so the fast gate can be vetoed', {
  durationMs: 30_000,
  accel: gaitTrace(2.8, 5.5),
  gyroRps: 1.4,
  speedKmh: 11,
  assertFn: (c) => c.gait === 'RUN' && c.verdict === 'FOOT',
});

all &= run('3. THE TARGET CASE: 1 km/h creep in a vehicle, Doppler reads 0 — VEHICLE within ~10 s', {
  durationMs: 60_000,
  accel: roadTrace(0.25),
  gyroRps: 0.05,
  speedKmh: 0, // Doppler floors out at a crawl — this is the whole problem
  groundKmh: 1.0, // displacement over the sliding 8-30 s baseline tells the truth
  assertFn: (c, at) => c.verdict === 'VEHICLE' && c.gait === 'NONE' && at !== null && at <= 12_000,
});

all &= run('4. Rough road at 15 km/h, no AR verdict — vibration must NOT read as a gait', {
  durationMs: 60_000,
  accel: roadTrace(2.0),
  gyroRps: 0.18,
  speedKmh: 15,
  assertFn: (c) => c.gait !== 'RUN' && c.verdict === 'VEHICLE',
});

all &= run('5. Parked, engine idling, phone on the seat — no gait, and NO vehicle verdict (not moving)', {
  durationMs: 60_000,
  accel: idleTrace,
  gyroRps: 0.02,
  speedKmh: 0,
  groundKmh: 0,
  assertFn: (c) => c.gait === 'NONE' && c.verdict !== 'VEHICLE',
});

all &= run('6. Walking WITH a stale IN_VEHICLE verdict from Play Services — gait still wins', {
  durationMs: 40_000,
  accel: gaitTrace(1.9, 3.0),
  gyroRps: 1.1,
  speedKmh: 5,
  ar: { vehicle: 65, foot: 0 },
  assertFn: (c) => c.gait === 'WALK' && c.verdict !== 'VEHICLE',
});

all &= run('7. Driving at 45 km/h while Play Services still says ON_FOOT — speed overrides', {
  durationMs: 40_000,
  accel: roadTrace(0.8),
  gyroRps: 0.1,
  speedKmh: 45,
  ar: { vehicle: 0, foot: 70 },
  assertFn: (c) => c.verdict === 'VEHICLE',
});

all &= run('8. Walk 20 s, then get in and creep at 1.5 km/h — verdict flips to VEHICLE', {
  durationMs: 80_000,
  accel: (t) => (t < 20 ? gaitTrace(1.8, 2.5)(t) : roadTrace(0.3)(t)),
  gyroRps: (t) => (t < 20 ? 0.9 : 0.05),
  speedKmh: (t) => (t < 20 ? 4.5 : 0),
  groundKmh: (t) => (t < 20 ? 4.5 : 1.5),
  assertFn: (c) => c.verdict === 'VEHICLE',
});

console.log(`\n${all ? 'ALL SCENARIOS PASS ✅' : 'SOME FAILED ❌'}`);
process.exit(all ? 0 : 1);
