/**
 * Simulation of TRIP START — StartGate.kt, driven through a model of the phone around it.
 *
 * The question it answers: can GPS noise on a phone that is not going anywhere start a trip, and
 * does a vehicle that really leaves still get one, with its route intact?
 *
 * What is modelled
 *   - StartGate itself, via its line-for-line mirror in start-gate.mjs.
 *   - The service around it (TrackingService.kt, idle branch): GPS cadence (10 s idle, 2 s while
 *     a departure is suspected, 30 s dormant after ten idle minutes), the accuracy gates, the
 *     speed the service derives, the long-baseline ground speed, what it feeds the classifier,
 *     the pre-start buffer and its flush from the route's origin fix.
 *   - MotionClassifier's verdict, INCLUDING its weakness: "covering ground with no gait under
 *     it" takes ground speed from the fixes, so a wandering fix on a still phone on a desk reads
 *     as a creeping vehicle. The scenarios do not get to assume the sensors are right.
 *   - The world: true motion (parked, driving, crawling, walking), and GPS error on top of it —
 *     correlated wander, jumps, wild outliers, positions that relocate and stay, understated
 *     accuracy, speed spikes that arrive with jumps, handsets that report no speed or always 0.
 *
 * What it cannot prove: how a real receiver's error is distributed. The noise here is a set of
 * shapes, sized from one field capture (trip 6abe7d98) and pushed well past it. The hard claim
 * does not depend on the shapes at all — see "inside the circle, anything goes".
 *
 * SIM_LEGACY=1 also runs the previous start logic through every "must not start" case, to show
 * the cases really are the bug. SIM_DEBUG=1 lists up to 40 failing seeds per family, with why.
 *
 * Run: node modules/vehicle-tracker/__sim__/start-gate.sim.mjs
 */

import { StartGate, LegacyStart, Decision, START_RADIUS_M } from './start-gate.mjs';

// ── Service constants (must match TrackingService.kt) ──
const STATIONARY_S = 10;
const MOVING_S = 2;
const DORMANT_S = 30;
const DEPART_WATCH_MS = 30_000;
const IDLE_TIMEOUT_S = 600;
const MAX_ACCURACY_M = 100;
const TRIP_START_MAX_ACCURACY_M = 50;
const PRE_START_BUFFER_MS = 30 * 60_000;
const PRE_START_BUFFER_MAX = 240;
const PRE_START_BUFFER_SPACING_M = 5;
const GROUND_REF_MIN_MS = 8_000;
const GROUND_REF_MAX_MS = 30_000;
const MAX_PLAUSIBLE_SPEED_KMH = 180;
const FOOT_VETO_MS = 10 * 60_000;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ── Deterministic randomness ──
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const uni = (r, lo, hi) => lo + (hi - lo) * r();
const polar = (r, m) => { const a = uni(r, 0, 2 * Math.PI); return { x: m * Math.cos(a), y: m * Math.sin(a) }; };

// ── MotionClassifier, reduced to its score (see evaluate() in MotionClassifier.kt) ──
function makeClassifier() {
  let score = 0;
  let verdict = 'UNKNOWN';
  const win = [];
  return {
    onGpsFix(effectiveKmh) { win.push(effectiveKmh); if (win.length > 8) win.shift(); },
    evaluate({ haveAccel, gait, riding, arVehicle, arFoot, gyroCarried }) {
      const sorted = [...win].sort((a, b) => a - b);
      const speed = sorted.length ? sorted[Math.floor((sorted.length * 4) / 10)] : 0;
      let ev = 0;
      if (speed >= 20) ev += 4;
      else if (speed >= 12 && gait !== 'run') ev += 2;
      if (gait !== 'none') ev -= 3;
      const isRiding = haveAccel && gait === 'none' && riding;
      if (isRiding && speed >= 0.7) ev += 2;
      if (arVehicle) ev += 3;
      if (arFoot) ev -= 3;
      if (isRiding && speed >= 0.7 && !gyroCarried) ev += 1;
      if (gyroCarried) ev -= 2;
      score = ev === 0 ? score * 0.85 : score + ev;
      score = Math.max(-12, Math.min(12, score));
      if (score >= 6) verdict = 'VEHICLE';
      else if (score <= -6) verdict = 'FOOT';
      else if (verdict === 'VEHICLE' && score >= 2) verdict = 'VEHICLE';
      else if (verdict === 'FOOT' && score <= -2) verdict = 'FOOT';
      else verdict = 'UNKNOWN';
    },
    get isVehicle() { return verdict === 'VEHICLE'; },
  };
}

// What the body of the phone is doing, for the classifier and Play Services.
const DESK = { gait: 'none', riding: true, gyroCarried: false, arVehicle: false, arFoot: false };
const CAR = { gait: 'none', riding: true, gyroCarried: false, arVehicle: false, arFoot: false };
const CAR_AR = { ...CAR, arVehicle: true };
const WALK = { gait: 'walk', riding: false, gyroCarried: true, arVehicle: false, arFoot: true };
const AMBLE = { gait: 'none', riding: false, gyroCarried: false, arVehicle: false, arFoot: false };
const RUN = { gait: 'run', riding: false, gyroCarried: true, arVehicle: false, arFoot: true };

// ── True motion ──
const straight = (d) => ({ x: d, y: 0 });
/** One lap of a 40 m circle that passes through the origin (a car park), then away. */
const lapThenLeave = (d) => {
  const R = 40;
  const lap = 2 * Math.PI * R;
  if (d <= lap) { const a = d / R; return { x: R * Math.sin(a), y: R * (1 - Math.cos(a)) }; }
  return { x: d - lap, y: 0 };
};
function mkTruth({ durationS, kmhAt, path = straight, origin = { x: 0, y: 0 } }) {
  const travelled = new Float64Array(durationS + 2);
  for (let t = 1; t <= durationS + 1; t++) travelled[t] = travelled[t - 1] + Math.max(0, kmhAt(t - 1)) / 3.6;
  return (t) => {
    const d = travelled[Math.min(Math.max(0, t), durationS + 1)];
    const p = path(d);
    return { x: origin.x + p.x, y: origin.y + p.y, kmh: Math.max(0, kmhAt(t)), travelled: d };
  };
}
const parkedTruth = (durationS) => mkTruth({ durationS, kmhAt: () => 0 });
/** Parked until departS, then accelerate to `kmh` at `accel` m/s². */
const departTruth = (durationS, departS, kmh, accel = 1.5, path = straight) =>
  mkTruth({ durationS, path, kmhAt: (t) => (t < departS ? 0 : Math.min(kmh, (t - departS) * accel * 3.6)) });

// ── GPS error ──
function mkNoise(r, spec = {}) {
  const {
    sigma = 0, rho = 0.97, white = 0,
    jumps = null, outliers = null, relocations = [], drift = null, script = null,
    clampM = Infinity, anchorBiasM = 0,
    accuracy = [4, 12], badAccuracyProb = 0,
    dormant = null,
  } = spec;
  let wander = { x: 0, y: 0 };
  let jump = null; // { vec, untilS }
  let outlierFixes = 0;
  let outlierVec = { x: 0, y: 0 };
  let eventNow = false; // a jump / outlier / relocation began since the last fix
  let firstFix = true;
  const bias = anchorBiasM ? polar(r, anchorBiasM) : null;
  let lastScriptIdx = -1;

  return {
    step(tS) {
      if (sigma > 0) {
        const k = Math.sqrt(1 - rho * rho) * sigma;
        wander = { x: rho * wander.x + k * gauss(r), y: rho * wander.y + k * gauss(r) };
      }
      if (jump && tS >= jump.untilS) { jump = null; eventNow = true; }
      if (!jump && jumps && r() < jumps.perHour / 3600) {
        jump = { vec: polar(r, uni(r, jumps.minM, jumps.maxM)), untilS: tS + uni(r, jumps.minS, jumps.maxS) };
        eventNow = true;
      }
      for (const rel of relocations) if (tS === rel.atS || tS === rel.untilS) eventNow = true;
    },
    sample(tS, isDormant) {
      let off;
      let scripted = null;
      if (script) {
        const cyc = tS % script.cycleS;
        let idx = 0;
        for (let i = 0; i < script.fixes.length; i++) if (script.fixes[i][0] <= cyc) idx = i;
        const [, d, dop, acc] = script.fixes[idx];
        const fresh = idx !== lastScriptIdx;
        lastScriptIdx = idx;
        off = { x: d, y: 0 };
        scripted = { doppler: fresh ? dop : 0, accuracy: acc };
      } else {
        off = { x: wander.x, y: wander.y };
        if (white > 0) { off.x += white * gauss(r); off.y += white * gauss(r); }
        if (jump) { off.x += jump.vec.x; off.y += jump.vec.y; }
        if (isDormant && dormant) {
          off.x += dormant.sigma * gauss(r); off.y += dormant.sigma * gauss(r);
          if (r() < dormant.hopProb) { const h = polar(r, uni(r, dormant.hopMin, dormant.hopMax)); off.x += h.x; off.y += h.y; eventNow = true; }
        }
        // The promise of the "inside" cases: ordinary error never carries the fix past clampM.
        const m = Math.hypot(off.x, off.y);
        if (m > clampM) { off.x *= clampM / m; off.y *= clampM / m; }
      }
      for (const rel of relocations) {
        if (tS >= rel.atS && tS < rel.untilS) { off.x += rel.dx; off.y += rel.dy; }
      }
      if (drift && tS >= drift.atS) {
        const m = Math.min(drift.maxM, ((tS - drift.atS) * drift.kmh) / 3.6);
        off.x += m * drift.ux; off.y += m * drift.uy;
      }
      // Wild fixes: one or two in a row, then back.
      if (outlierFixes > 0) {
        off = { x: off.x + outlierVec.x, y: off.y + outlierVec.y };
        outlierFixes--;
      } else if (outliers && r() < outliers.perFix) {
        outlierVec = polar(r, uni(r, outliers.minM, outliers.maxM));
        off = { x: off.x + outlierVec.x, y: off.y + outlierVec.y };
        outlierFixes = r() < 0.4 ? 1 : 0;
        eventNow = true;
      }
      if (firstFix && bias) { off = { x: off.x + bias.x, y: off.y + bias.y }; }
      firstFix = false;
      const acc = scripted ? scripted.accuracy
        : r() < badAccuracyProb ? uni(r, 55, 95) : uni(r, accuracy[0], accuracy[1]);
      const ev = eventNow;
      eventNow = false;
      return { off, accuracy: acc, event: ev, scriptedDoppler: scripted ? scripted.doppler : null };
    },
  };
}

/** What the receiver reports as its own speed. null = this handset reports none. */
function dopplerReading(r, handset, trueKmh, n, spec) {
  if (handset.doppler === 'none') return null;
  if (handset.doppler === 'zero') return 0;
  if (n.scriptedDoppler !== null) return n.scriptedDoppler;
  const { dopplerSpikeProb = 0, spikeWithEvent = 0 } = spec;
  if (trueKmh >= 2.5) return Math.max(0, trueKmh + 0.6 * gauss(r));
  if (n.event && r() < spikeWithEvent) return uni(r, 5, 30);
  if (r() < dopplerSpikeProb) return uni(r, 5, 30);
  return Math.abs(0.3 * gauss(r));
}

/**
 * Run the phone for `durationS` seconds, idle, until a trip starts or time runs out.
 * `override(tS, fix)` may rewrite a fix's inputs wholesale — the adversarial cases use it.
 */
function simulate({
  durationS, truth, noise: noiseSpec = {}, handset = { doppler: 'yes', accel: true },
  body = () => DESK, gate = new StartGate(), seed = 1, override = null, endedAt = null,
  departS = null, startDormant = false,
}) {
  const r = mulberry32(seed);
  const noise = mkNoise(r, noiseSpec);
  const cls = makeClassifier();
  const buffer = [];
  let dormant = startDormant;
  let idleStartS = 0;
  let departWatchUntil = -1;
  let nextFixS = 0;
  let lastFix = null;
  let groundRef = null;
  let lastGroundKmh = null;
  let lastGroundAt = -Infinity;
  let lastActivity = null;
  let lastActivityAt = -Infinity;
  let prevBodyKey = '';
  const stats = { fixes: 0, fastGpsFixes: 0, reanchors: 0, dormantS: 0, exits: 0 };
  if (endedAt) gate.anchorAt(endedAt, 0);

  for (let tS = 0; tS <= durationS; tS++) {
    const now = tS * 1000;
    const tr = truth(tS);
    const b = body(tS);
    noise.step(tS);
    // Play Services transitions land when the activity CHANGES (see ActivityTransitionReceiver).
    const key = b.arFoot ? 'foot' : b.arVehicle ? 'vehicle' : '';
    if (key && key !== prevBodyKey) { lastActivity = key; lastActivityAt = now; }
    prevBodyKey = key;
    cls.evaluate({ haveAccel: handset.accel, ...b });
    if (dormant) stats.dormantS++;

    if (tS >= nextFixS) {
      const n = noise.sample(tS, dormant);
      let fix = {
        pos: { x: tr.x + n.off.x, y: tr.y + n.off.y },
        accuracy: n.accuracy,
        doppler: dopplerReading(r, handset, tr.kmh, n, noiseSpec),
      };
      let forced = null;
      if (override) forced = override(tS, fix, r, gate) || null;
      stats.fixes++;

      if (fix.accuracy <= MAX_ACCURACY_M) {
        const derived = lastFix && now > lastFix.now ? (dist(lastFix.pos, fix.pos) / ((now - lastFix.now) / 1000)) * 3.6 : null;
        const speedKmh = fix.doppler ?? derived ?? 0;
        lastFix = { pos: fix.pos, now };
        // groundSpeedKmh(): displacement over a sliding 8-30 s baseline.
        let groundKmh = null;
        if (!groundRef) groundRef = { pos: fix.pos, now };
        else {
          const el = now - groundRef.now;
          if (el < GROUND_REF_MIN_MS) groundKmh = now - lastGroundAt <= GROUND_REF_MAX_MS * 2 ? lastGroundKmh : null;
          else {
            groundKmh = (dist(groundRef.pos, fix.pos) / (el / 1000)) * 3.6;
            lastGroundKmh = groundKmh; lastGroundAt = now;
            if (el >= GROUND_REF_MAX_MS) groundRef = { pos: fix.pos, now };
          }
        }
        const recentKmh = Math.max(speedKmh, groundKmh ?? 0);
        // The classifier is fed the receiver's own reading and the long-baseline speed, never the
        // fix-to-fix one: two noisy fixes 2 s apart read as 15-20 km/h on a phone going nowhere.
        // (The previous service fed it fix-to-fix speed on handsets with no reading of their own.)
        cls.onGpsFix(gate instanceof LegacyStart ? recentKmh : Math.max(fix.doppler ?? 0, groundKmh ?? 0));

        if (fix.accuracy <= TRIP_START_MAX_ACCURACY_M) {
          // Pre-start buffer (spacing-gated, age- and size-bounded).
          const lastBuf = buffer[buffer.length - 1];
          if (!lastBuf || dist(lastBuf.pos, fix.pos) >= PRE_START_BUFFER_SPACING_M) {
            buffer.push({ pos: fix.pos, now, accuracy: fix.accuracy, travelled: tr.travelled });
            while (buffer.length > PRE_START_BUFFER_MAX) buffer.shift();
            while (buffer.length && now - buffer[0].now > PRE_START_BUFFER_MS) buffer.shift();
          }

          const vehicleConfirmed = forced?.vehicleConfirmed ?? cls.isVehicle;
          if (vehicleConfirmed && dormant) { dormant = false; idleStartS = tS; }
          const footRecently = forced?.footRecently ?? (lastActivity === 'foot' && now - lastActivityAt < FOOT_VETO_MS);
          const wasConfirmed = gate.exitConfirmed;
          const decision = gate.onFix({
            now, pos: fix.pos, accuracyM: fix.accuracy, dopplerKmh: fix.doppler,
            recentKmh: forced?.recentKmh ?? recentKmh,
            vehicleConfirmed,
            activitySaysVehicle: forced?.activitySaysVehicle ?? b.arVehicle,
            footRecently,
            gaitUsable: forced?.gaitUsable ?? handset.accel,
            runningOnFoot: forced?.runningOnFoot ?? (b.gait === 'run' && !cls.isVehicle),
          });
          if (gate.wantsFastGps) departWatchUntil = now + DEPART_WATCH_MS;
          if (gate.exitConfirmed && !wasConfirmed) stats.exits++;
          if (gate.exitConfirmed && dormant) { dormant = false; idleStartS = tS; }
          if (decision === Decision.REANCHOR) stats.reanchors++;

          if (decision === Decision.START_FAST || decision === Decision.START_SLOW || decision === Decision.START_VEHICLE) {
            // The flush, exactly as the service does it.
            const origin = gate.routeOrigin(buffer.map((f) => f.now), now);
            const route = [];
            let prev = null;
            if (origin.isRoutePoint) {
              prev = { pos: origin.pos, now: origin.elapsedMs, accuracy: null, travelled: truth(Math.round(origin.elapsedMs / 1000)).travelled };
              route.push(prev);
            }
            for (const f of buffer) {
              if (f.now <= origin.elapsedMs || f.now >= now) continue;
              if (prev) {
                const d = dist(prev.pos, f.pos);
                if (d < Math.max(8, (f.accuracy ?? 30) * 0.75)) continue;
                if ((d / Math.max(0.001, (f.now - prev.now) / 1000)) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) continue;
              }
              route.push(f);
              prev = f;
            }
            route.push({ pos: fix.pos, now, travelled: tr.travelled });
            let maxGapM = 0;
            for (let i = 1; i < route.length; i++) maxGapM = Math.max(maxGapM, Math.abs(route[i].travelled - route[i - 1].travelled));
            const departTravelled = departS !== null ? truth(departS).travelled : 0;
            return {
              started: true, atS: tS, gate: decision.replace('START_', '').toLowerCase(),
              startDistM: tr.travelled - departTravelled,
              startLagS: departS !== null ? tS - departS : null,
              originGapM: Math.max(0, route[0].travelled - departTravelled),
              routeStartS: route[0].now / 1000,
              // How long before the vehicle really set off the route (and so the trip) begins.
              leadS: departS !== null ? Math.max(0, departS - route[0].now / 1000) : null,
              routePoints: route.length, maxGapM, stats,
              why: gate.lastEval ? `leg ${gate.lastEval.legKmh.toFixed(1)} km/h, doppler ${gate.lastEval.dopplerOk ? 'ok' : 'no'}, progress ${gate.lastEval.ring}/${gate.lastEval.prog}, ${gate.lastEval.d.toFixed(0)} m out` : '',
            };
          }
        }
      }
      if (now < departWatchUntil) stats.fastGpsFixes++;
      nextFixS = tS + (now < departWatchUntil ? MOVING_S : dormant ? DORMANT_S : STATIONARY_S);
    }

    // The 20 s ticker: idle timeout drops to the low-power watch — unless an exit is being
    // judged and fixes are still arriving (each outside fix renews the depart watch).
    const exitPending = gate.exitConfirmed && now < departWatchUntil;
    if (tS % 20 === 0 && !dormant && !exitPending && tS - idleStartS >= IDLE_TIMEOUT_S) {
      dormant = true;
      idleStartS = tS;
    }
  }
  return { started: false, stats };
}

// ── The field capture: trip 6abe7d98, a phone on a desk. [second, metres from first fix, Doppler, accuracy] ──
const FIELD_JITTER = {
  cycleS: 410,
  fixes: [
    [0, 0, 0, 11.9], [22, 31.1, 0, 4.1], [32, 30.2, 1.85, 9.1], [41, 7.9, 0.39, 14.1],
    [49, 19.1, 0.29, 10.1], [61, 23.9, 0.72, 7.1], [73, 28.1, 0.34, 5.1], [83, 34.8, 0, 3.8],
    [126, 21.9, 0, 5.1], [167, 14.7, 0, 6], [187, 8.4, 0.12, 7.9], [227, 19.2, 0, 1.7],
    [307, 28.6, 0, 2.1], [344, 37.3, 4.3, 3.4], [356, 3.1, 24.7, 11.5], [364, 37.9, 0, 4],
    [401, 37.5, 0.22, 5.1],
  ],
};

// ── Reporting ──
let failed = 0;
const LEGACY = process.env.SIM_LEGACY === '1';
const H = 3600;
function line(ok, name, detail = '') {
  console.log(`${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
/** A case that must NOT start a trip. Also shows what the previous logic did with it. */
function mustNotStart(name, cfg) {
  const res = simulate({ ...cfg, gate: new StartGate() });
  const hours = (cfg.durationS / H).toFixed(cfg.durationS >= H ? 0 : 1);
  let legacy = '';
  if (LEGACY) {
    const old = simulate({ ...cfg, gate: new LegacyStart() });
    const patched = simulate({ ...cfg, gate: new LegacyStart({ withDopplerVeto: true }) });
    legacy = ` · before: ${old.started ? `STARTED at ${old.atS}s` : 'no trip'} · 1 Oct patch: ${patched.started ? `STARTED at ${patched.atS}s` : 'no trip'}`;
  }
  line(!res.started, name, res.started
    ? `STARTED at ${res.atS}s via ${res.gate}`
    : `no trip in ${hours} h (${res.stats.exits} exit(s), ${res.stats.reanchors} re-anchor(s))${legacy}`);
  return res;
}
/** A case that MUST start a trip. `limits` bound how late and how incomplete it may be. */
function mustStart(name, cfg, { maxStartDistM, maxOriginGapM = 40, maxLeadS = 60, gate = null } = {}) {
  const res = simulate({ ...cfg, gate: new StartGate() });
  const ok = res.started &&
    (maxStartDistM === undefined || res.startDistM <= maxStartDistM) &&
    res.originGapM <= maxOriginGapM &&
    (res.leadS === null || res.leadS <= maxLeadS) &&
    (gate === null || gate.includes(res.gate));
  line(ok, name, res.started
    ? `${res.gate} gate, ${res.startDistM.toFixed(0)} m / ${res.startLagS}s after setting off · route begins ${res.originGapM.toFixed(0)} m from the origin, ${(res.leadS ?? 0).toFixed(0)}s before setting off · ${res.routePoints} points, widest gap ${res.maxGapM.toFixed(0)} m`
    : 'NO TRIP');
  return res;
}

console.log('━━ A. The phone is not going anywhere: no trip, whatever GPS does ━━');

mustNotStart('A1. FIELD CASE (trip 6abe7d98): login on a desk, the recorded jitter, 2 h', {
  durationS: 2 * H, truth: parkedTruth(2 * H), noise: { script: FIELD_JITTER }, seed: 11,
});
mustNotStart('A2. Same jitter, and Play Services wrongly says "in vehicle" the whole time', {
  durationS: 2 * H, truth: parkedTruth(2 * H), noise: { script: FIELD_JITTER }, seed: 12,
  body: () => ({ ...DESK, arVehicle: true }),
});
const LIES = { vehicleConfirmed: true, activitySaysVehicle: true, footRecently: false, gaitUsable: true, runningOnFoot: false, recentKmh: 60 };
mustNotStart('A3. INSIDE THE CIRCLE, ANYTHING GOES: every fix a random point within 149 m of the anchor, speed readings up to 120 km/h, every sensor lying "vehicle", 24 h', {
  durationS: 24 * H, truth: parkedTruth(24 * H), seed: 13,
  override: (tS, fix, r, gate) => {
    if (tS < 60) return null; // let the anchor settle on real fixes first
    const p = polar(r, 149 * Math.sqrt(r()));
    fix.pos = { x: gate.anchor.x + p.x, y: gate.anchor.y + p.y }; fix.accuracy = uni(r, 2, 25); fix.doppler = uni(r, 0, 120);
    return LIES;
  },
});
mustNotStart('A3b. The same, stated about the PHONE: every fix (the first ones too) a random point within 60 m of where it really is, sensors lying, 24 h', {
  durationS: 24 * H, truth: parkedTruth(24 * H), seed: 113,
  override: (tS, fix, r) => {
    fix.pos = polar(r, 60 * Math.sqrt(r())); fix.accuracy = uni(r, 2, 25); fix.doppler = uni(r, 0, 120);
    return LIES;
  },
});
mustNotStart('A4. Wild fixes: every ~2 min one or two fixes land 200-2000 m away with a speed spike, sensors lying, 12 h', {
  durationS: 12 * H, truth: parkedTruth(12 * H), seed: 14,
  noise: { sigma: 6, white: 3, outliers: { perFix: 0.08, minM: 200, maxM: 2000 }, spikeWithEvent: 1 },
  override: () => ({ vehicleConfirmed: true, activitySaysVehicle: true }),
});
mustNotStart('A5. The position RELOCATES 250 m and stays for 10 min, then comes back — four times', {
  durationS: 3 * H, truth: parkedTruth(3 * H), seed: 15,
  noise: {
    sigma: 5, white: 2, spikeWithEvent: 1,
    relocations: [0, 1, 2, 3].map((i) => ({ atS: 900 + i * 2400, untilS: 1500 + i * 2400, dx: 250 * (i % 2 ? -1 : 1), dy: 60 })),
  },
});
mustNotStart('A6. The same relocations on a handset that reports NO speed at all', {
  durationS: 3 * H, truth: parkedTruth(3 * H), seed: 16, handset: { doppler: 'none', accel: true },
  noise: {
    sigma: 5, white: 2,
    relocations: [0, 1, 2, 3].map((i) => ({ atS: 900 + i * 2400, untilS: 1500 + i * 2400, dx: 250 * (i % 2 ? -1 : 1), dy: 60 })),
  },
});
mustNotStart('A7. Overnight, dormant: 8 h of 30 s network fixes hopping 60-140 m', {
  durationS: 8 * H, truth: parkedTruth(8 * H), seed: 17, startDormant: true, endedAt: { x: 0, y: 0 },
  noise: { sigma: 8, clampM: 145, accuracy: [15, 45], dormant: { sigma: 25, hopProb: 0.15, hopMin: 60, hopMax: 140 } },
});
mustNotStart('A8. The very first fix is 100 m wrong (a bad anchor), then ordinary jitter, 4 h', {
  durationS: 4 * H, truth: parkedTruth(4 * H), seed: 18,
  noise: { sigma: 8, white: 4, anchorBiasM: 100, jumps: { perHour: 20, minM: 20, maxM: 45, minS: 5, maxS: 90 }, spikeWithEvent: 0.7 },
});
mustNotStart('A9. Phantom speed: 5% of fixes read 5-30 km/h on a parked phone, 12 h', {
  durationS: 12 * H, truth: parkedTruth(12 * H), seed: 19,
  noise: { sigma: 8, white: 4, dopplerSpikeProb: 0.05, jumps: { perHour: 30, minM: 20, maxM: 60, minS: 5, maxS: 60 }, spikeWithEvent: 1 },
});
mustNotStart('A10. A trip just ended here; 10 h parked in the field jitter', {
  durationS: 10 * H, truth: parkedTruth(10 * H), noise: { script: FIELD_JITTER }, seed: 20, endedAt: { x: 20, y: 0 },
});
mustNotStart('A11. A 100 m reposition inside a car park (by design: it never leaves the circle)', {
  durationS: 1800, seed: 21, departS: 600,
  truth: mkTruth({ durationS: 1800, kmhAt: (t) => (t >= 600 && t < 636 ? 10 : 0) }),
  noise: { sigma: 4, white: 2 }, body: (t) => (t >= 600 && t < 636 ? CAR_AR : DESK),
});

console.log('\n━━ B. The vehicle really leaves: a trip starts, and its route begins where the vehicle did ━━');

const parkNoise = { sigma: 7, white: 3, jumps: { perHour: 25, minM: 15, maxM: 40, minS: 5, maxS: 60 }, spikeWithEvent: 0.5 };
const departure = (kmh, extra = {}, departAt = 1800, tail = 600) => ({
  durationS: departAt + tail, departS: departAt, truth: departTruth(departAt + tail, departAt, kmh), noise: parkNoise,
  body: (t) => (t >= departAt ? CAR : DESK), seed: 100 + Math.round(kmh * 7), ...extra,
});
mustStart('B1. 30 min parked in jitter, then pull away at 30 km/h', departure(30), { maxStartDistM: 260 });
mustStart('B2. Pull away at 60 km/h', departure(60), { maxStartDistM: 330 });
mustStart('B3. Already at 110 km/h when the service starts (restart mid-drive)', {
  durationS: 120, departS: 0, truth: mkTruth({ durationS: 120, kmhAt: () => 110 }), noise: { sigma: 3 }, body: () => CAR, seed: 31,
}, { maxStartDistM: 700, maxOriginGapM: 10 });
mustStart('B4. Jam crawl at 2 km/h, speed reading zero — starts on leaving the circle, route from the first metres', departure(2, {}, 1800, 900), { maxStartDistM: 200, gate: ['vehicle', 'slow'] });
mustStart('B5. 1 km/h creep (nine minutes to leave the circle)', departure(1, {}, 1800, 1200), { maxStartDistM: 200, maxOriginGapM: 80, gate: ['vehicle', 'slow'] });
mustStart('B6. 4 km/h with Play Services saying "in vehicle"', departure(4, { body: (t) => (t >= 1800 ? CAR_AR : DESK) }, 1800, 600), { maxStartDistM: 200 });
mustStart('B7. Stop-go queue: 10 m, halt a minute, 10 m, halt a minute...', {
  durationS: 4200, departS: 600, seed: 37, noise: { sigma: 3, white: 1.5 }, body: (t) => (t >= 600 ? CAR : DESK),
  truth: mkTruth({ durationS: 4200, kmhAt: (t) => (t >= 600 && (t - 600) % 72 < 12 ? 3 : 0) }),
}, { maxStartDistM: 220, gate: ['vehicle', 'slow'] });
mustStart('B8. Handset reports NO speed: pull away at 30 km/h', departure(30, { handset: { doppler: 'none', accel: true } }), { maxStartDistM: 300 });
mustStart('B9. Handset whose speed field is stuck at ZERO: 40 km/h', departure(40, { handset: { doppler: 'zero', accel: true } }), { maxStartDistM: 420 });
mustStart('B10. No accelerometer and no Play Services: 30 km/h', departure(30, { handset: { doppler: 'yes', accel: false } }, 300), { maxStartDistM: 300 });
mustStart('B10b. The same handset, dormant (30 s fixes, nothing to wake it): 30 km/h — late and coarse, but it starts', departure(30, { handset: { doppler: 'yes', accel: false } }), { maxStartDistM: 520 });
mustStart('B11. Dormant overnight, then drive off at 40 km/h', {
  ...departure(40, {}, 6 * H, 300), startDormant: true, endedAt: { x: 0, y: 0 }, seed: 41,
  noise: { ...parkNoise, clampM: 100, dormant: { sigma: 20, hopProb: 0.05, hopMin: 50, hopMax: 90 } },
}, { maxStartDistM: 600, maxOriginGapM: 120 });
mustStart('B12. One lap of the car park (stays within 80 m), then away at 25 km/h', {
  durationS: 1500, departS: 900, truth: departTruth(1500, 900, 25, 1.2, lapThenLeave), noise: parkNoise,
  body: (t) => (t >= 900 ? CAR : DESK), seed: 42,
}, { maxStartDistM: 520, maxOriginGapM: 300 });
mustStart('B13. Bad accuracy at the depot (35-48 m reported), then 30 km/h', departure(30, { noise: { ...parkNoise, accuracy: [35, 48] } }), { maxStartDistM: 300 });

console.log('\n━━ C. On foot: leaving the circle is not a trip ━━');

const walk = (kmh, bodyOf, extra = {}) => ({
  durationS: 1500, truth: mkTruth({ durationS: 1500, kmhAt: (t) => (t >= 120 ? kmh : 0) }),
  noise: { sigma: 4, white: 2 }, body: (t) => (t >= 120 ? bodyOf : DESK), seed: 200 + Math.round(kmh * 3), ...extra,
});
mustNotStart('C1. Walk at 4.5 km/h for 23 min (1.7 km): the circle follows the walker', walk(4.5, WALK));
mustNotStart('C2. Run at 11 km/h', walk(11, RUN));
mustNotStart('C3. Slow amble at 3 km/h that the gait detector misses, Play Services silent', walk(3, AMBLE));
mustNotStart('C4. Brisk 6.5 km/h walk on a handset with no accelerometer', walk(6.5, WALK, { handset: { doppler: 'yes', accel: false } }));
// C5 — walk to the vehicle (it ends up INSIDE the circle of the last re-anchor), sit, drive.
const walkSitDrive = (sitS, seed) => {
  const walkEnd = 120 + Math.round(400 / (4.5 / 3.6));
  const driveAt = walkEnd + sitS;
  return {
    walkEnd, driveAt,
    cfg: {
      durationS: driveAt + 300, departS: driveAt, seed, noise: { sigma: 4, white: 2 },
      truth: mkTruth({ durationS: driveAt + 300, kmhAt: (t) => (t >= 120 && t < walkEnd ? 4.5 : t >= driveAt ? Math.min(30, (t - driveAt) * 5.4) : 0) }),
      body: (t) => (t >= 120 && t < walkEnd ? WALK : t >= driveAt ? CAR : DESK),
    },
  };
};
{
  const { walkEnd, driveAt, cfg } = walkSitDrive(120, 55);
  // Two minutes is too short to call a rest, so the route reaches back over the sit to the
  // last fix near the anchor: that is the bound on how early a trip can begin (RING_DWELL_MS).
  const res = mustStart('C5. Walk 400 m to the vehicle, sit 2 min, drive off at 30 km/h — one trip, and it is the drive', cfg,
    { maxStartDistM: 420, maxOriginGapM: 40, maxLeadS: 300 });
  line(res.started && res.atS > driveAt, '    …and it started during the drive, not the walk', res.started ? `started ${res.atS - driveAt}s after driving off` : '');
  if (res.started) {
    const walked = Math.max(0, walkEnd - res.routeStartS) * (4.5 / 3.6);
    console.log(`  note    …its route includes the last ${walked.toFixed(0)} m of the walk and the sit (the previous logic flushed up to 5 min of walking: unchanged in kind, smaller in size)`);
  }
}
{
  const { driveAt, cfg } = walkSitDrive(20 * 60, 56);
  const res = mustStart('C6. The same, but sitting in the vehicle for 20 min first — the trip begins when the drive does, not 20 min early', cfg,
    { maxStartDistM: 420, maxOriginGapM: 40, maxLeadS: 60 });
  line(res.started && res.atS > driveAt, '    …and it started during the drive', res.started ? `started ${res.atS - driveAt}s after driving off` : '');
}

// ── Fuzz ──
console.log('\n━━ D. Randomised: thousands of hours of each ━━');

function fuzz(name, n, mk, check) {
  let bad = 0; let hours = 0; const firstBad = [];
  const agg = [];
  for (let i = 0; i < n; i++) {
    const cfg = mk(i);
    const res = simulate({ ...cfg, gate: new StartGate() });
    hours += cfg.durationS / H;
    const verdict = check(res, cfg);
    if (verdict !== true) {
      bad++;
      const tag = `${cfg.handset?.doppler ?? 'yes'}/${cfg.handset?.accel === false ? 'no-accel' : 'accel'}${cfg.tag ? '/' + cfg.tag : ''}`;
      if (firstBad.length < (process.env.SIM_DEBUG ? 40 : 3)) firstBad.push(`seed ${cfg.seed} [${tag}]: ${verdict}${res.why ? ' (' + res.why + ')' : ''}`);
    }
    agg.push(res);
  }
  return { name, n, bad, hours, firstBad, agg };
}
function legacyStarts(n, mk, opts) {
  let started = 0;
  for (let i = 0; i < n; i++) if (simulate({ ...mk(i), gate: new LegacyStart(opts) }).started) started++;
  return started;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const pickHandset = (r) => {
  const a = r();
  return { doppler: a < 0.7 ? 'yes' : a < 0.85 ? 'none' : 'zero', accel: r() < 0.85 };
};

// D1 — parked. `reach` is how far ordinary error may carry a fix from where the phone really is.
const mkParkedWith = (reach, seedBase) => (i) => {
  const r = mulberry32(seedBase + i);
  const durationS = 6 * H;
  return {
    durationS, truth: parkedTruth(durationS), seed: seedBase + 4000 + i, handset: pickHandset(r),
    startDormant: r() < 0.3, endedAt: r() < 0.5 ? polar(r, uni(r, 0, Math.min(reach, 40))) : null,
    body: () => (r() < 0.02 ? { ...DESK, arVehicle: true } : DESK),
    noise: {
      sigma: uni(r, 1, reach / 5), rho: uni(r, 0.9, 0.995), white: uni(r, 0, reach / 10), clampM: reach,
      jumps: { perHour: uni(r, 0, 60), minM: 15, maxM: uni(r, 20, reach * 0.9), minS: 2, maxS: uni(r, 10, 600) },
      outliers: { perFix: uni(r, 0, 0.03), minM: 150 + reach, maxM: 1500 },
      accuracy: [3, uni(r, 8, 48)], badAccuracyProb: uni(r, 0, 0.15),
      dopplerSpikeProb: uni(r, 0, 0.04), spikeWithEvent: r(),
      dormant: { sigma: uni(r, 3, reach / 4), hopProb: uni(r, 0, 0.1), hopMin: reach / 3, hopMax: reach },
    },
  };
};
const mkParked = mkParkedWith(60, 1000);
const mkParkedStress = mkParkedWith(130, 7000);
const noStart = (res) => (res.started ? `started at ${res.atS}s via ${res.gate}` : true);
const d1 = fuzz('D1', 1500, mkParked, noStart);
line(d1.bad === 0, `D1. Parked, ${d1.n} phones × 6 h = ${d1.hours.toFixed(0)} h: error up to 60 m (wander, jumps, dormant hops), wild fixes of 200+ m, phantom speed, bad accuracy, every handset type`,
  `${d1.bad} phantom trips${d1.firstBad.length ? ' — ' + d1.firstBad.join('; ') : ''}`);

// D2 — the hard guarantee, fuzzed: anything at all inside the circle.
const mkInsideAnchor = (i) => {
  const r0 = mulberry32(20000 + i);
  const radius = uni(r0, 40, 149);
  return {
    durationS: 6 * H, truth: parkedTruth(6 * H), seed: 21000 + i, handset: pickHandset(r0),
    override: (tS, fix, r, gate) => {
      if (tS < 60) return null;
      const p = polar(r, radius * Math.sqrt(r()));
      fix.pos = { x: gate.anchor.x + p.x, y: gate.anchor.y + p.y };
      fix.accuracy = uni(r, 1, 50); fix.doppler = r() < 0.5 ? uni(r, 0, 150) : fix.doppler;
      return { vehicleConfirmed: r() < 0.9, activitySaysVehicle: r() < 0.9, footRecently: false, gaitUsable: true, runningOnFoot: false, recentKmh: uni(r, 0, 150) };
    },
  };
};
const d2 = fuzz('D2', 600, mkInsideAnchor, noStart);
line(d2.bad === 0, `D2. Adversarial, ${d2.n} × 6 h = ${d2.hours.toFixed(0)} h: random positions within 149 m of the anchor, random speeds to 150 km/h, sensors lying`,
  `${d2.bad} phantom trips${d2.firstBad.length ? ' — ' + d2.firstBad.join('; ') : ''}`);
const mkInsideTruth = (i) => {
  const r0 = mulberry32(25000 + i);
  const radius = uni(r0, 20, 60);
  return {
    durationS: 6 * H, truth: parkedTruth(6 * H), seed: 26000 + i, handset: pickHandset(r0),
    endedAt: r0() < 0.5 ? polar(r0, radius * Math.sqrt(r0())) : null,
    override: (tS, fix, r) => {
      fix.pos = polar(r, radius * Math.sqrt(r()));
      fix.accuracy = uni(r, 1, 50); fix.doppler = r() < 0.5 ? uni(r, 0, 150) : fix.doppler;
      return { vehicleConfirmed: r() < 0.9, activitySaysVehicle: r() < 0.9, footRecently: false, gaitUsable: true, runningOnFoot: false, recentKmh: uni(r, 0, 150) };
    },
  };
};
const d2b = fuzz('D2b', 600, mkInsideTruth, noStart);
line(d2b.bad === 0, `D2b. Adversarial, ${d2b.n} × 6 h = ${d2b.hours.toFixed(0)} h: every fix anywhere within 60 m of the phone (anchor included), random speeds, sensors lying`,
  `${d2b.bad} phantom trips${d2b.firstBad.length ? ' — ' + d2b.firstBad.join('; ') : ''}`);

// D3 — the position relocates beyond the circle and stays there.
const mkRelocate = (i) => {
  const r = mulberry32(30000 + i);
  const durationS = 3 * H;
  const k = 1 + Math.floor(r() * 5);
  const relocations = [];
  for (let j = 0; j < k; j++) {
    const atS = Math.floor(uni(r, 300, durationS - 2400));
    const v = polar(r, uni(r, 150, 600));
    relocations.push({ atS, untilS: atS + Math.floor(uni(r, 10, 1800)), dx: v.x, dy: v.y });
  }
  return {
    durationS, truth: parkedTruth(durationS), seed: 31000 + i, handset: pickHandset(r),
    startDormant: r() < 0.3,
    noise: {
      sigma: uni(r, 1, 9), rho: uni(r, 0.92, 0.99), white: uni(r, 0, 4), relocations,
      accuracy: [3, uni(r, 8, 40)], dopplerSpikeProb: uni(r, 0, 0.02), spikeWithEvent: 1,
    },
  };
};
const d3 = fuzz('D3', 1500, mkRelocate, noStart);
line(d3.bad === 0, `D3. Relocations, ${d3.n} × 3 h = ${d3.hours.toFixed(0)} h: the position jumps 150-600 m and STAYS for 10 s-30 min, with a speed spike on the jump, sensors fooled`,
  `${d3.bad} phantom trips${d3.firstBad.length ? ' — ' + d3.firstBad.join('; ') : ''}`);

// D4 — real departures.
const mkDepart = (i) => {
  const r = mulberry32(40000 + i);
  const crawl = r() < 0.35;
  const handset = pickHandset(r);
  let kmh = crawl ? uni(r, 0.9, 9.5) : uni(r, 10, 120);
  // Pre-existing limits, not regressions: below 10 km/h a trip needs the sensors, and below
  // ~14 km/h with no accelerometer nothing can tell a vehicle from a runner.
  if (!handset.accel && kmh < 14) kmh = uni(r, 14, 120);
  const departS = Math.floor(uni(r, 300, 2400));
  const needS = Math.ceil(700 / (kmh / 3.6)) + 240;
  const durationS = departS + needS;
  const ar = r() < 0.3;
  return {
    durationS, departS, seed: 41000 + i, handset, kmh,
    truth: departTruth(durationS, departS, kmh, uni(r, 0.6, 2.5)),
    startDormant: r() < 0.25 && departS > 900, endedAt: r() < 0.6 ? { x: 0, y: 0 } : null,
    body: (t) => (t >= departS ? (ar ? CAR_AR : CAR) : DESK),
    noise: {
      sigma: uni(r, 1, 9), rho: uni(r, 0.9, 0.99), white: uni(r, 0, 4), clampM: 45,
      jumps: { perHour: uni(r, 0, 30), minM: 10, maxM: 40, minS: 2, maxS: 60 },
      accuracy: [3, uni(r, 8, 24)], dopplerSpikeProb: uni(r, 0, 0.02), spikeWithEvent: r(),
    },
  };
};
const d4 = fuzz('D4', 3000, mkDepart, (res, cfg) => {
  if (!res.started) return `NO TRIP at ${cfg.kmh.toFixed(1)} km/h, handset ${cfg.handset.doppler}/${cfg.handset.accel ? 'accel' : 'no-accel'}`;
  // 150 m circle + anchor/noise slack + reaction time: three confirming fixes, one idle interval
  // (30 s if the phone had gone dormant), and the slower progress corroboration on handsets
  // with no usable speed reading.
  const reactS = 20 + (cfg.departS > 600 ? 30 : 0) + (cfg.handset.doppler !== 'yes' ? 14 : 0);
  const limit = 150 + 80 + (cfg.kmh / 3.6) * reactS;
  if (res.startDistM > limit) return `started ${res.startDistM.toFixed(0)} m out (limit ${limit.toFixed(0)}) at ${cfg.kmh.toFixed(1)} km/h`;
  return true;
});
{
  const ok = d4.agg.filter((x) => x.started);
  const gaps = ok.map((x) => x.originGapM);
  const dists = ok.map((x) => x.startDistM);
  const byGate = ok.reduce((m, x) => ({ ...m, [x.gate]: (m[x.gate] || 0) + 1 }), {});
  line(d4.bad === 0, `D4. Departures, ${d4.n} drives at 0.9-120 km/h after parking in jitter, every handset type`,
    `${d4.n - d4.bad}/${d4.n} started · confirmed ${pct(dists, 0.5).toFixed(0)} m out (median), ${pct(dists, 0.95).toFixed(0)} m (95%) · gates ${JSON.stringify(byGate)}${d4.firstBad.length ? ' — ' + d4.firstBad.join('; ') : ''}`);
  const gapOk = pct(gaps, 0.95) <= 80;
  line(gapOk, '    …and the route still begins where the vehicle did',
    `missing from the start of the route: ${pct(gaps, 0.5).toFixed(0)} m median, ${pct(gaps, 0.95).toFixed(0)} m at 95%, ${Math.max(...gaps).toFixed(0)} m worst`);
  // ...and WHEN it did: the trip's start time is its earliest point.
  const leads = ok.map((x) => x.leadS);
  line(pct(leads, 0.95) <= 60 && Math.max(...leads) <= 300, '    …and when it did',
    `the route begins before the vehicle set off by: ${pct(leads, 0.5).toFixed(0)}s median, ${pct(leads, 0.95).toFixed(0)}s at 95%, ${Math.max(...leads).toFixed(0)}s worst`);
}

// D5 — on foot.
const mkWalk = (i) => {
  const r = mulberry32(50000 + i);
  const handset = pickHandset(r);
  const running = r() < 0.2;
  const kmh = running ? uni(r, 8, handset.accel ? 13 : 11.5) : uni(r, 2.5, 6.8);
  const bodyOf = running ? RUN : r() < 0.8 ? WALK : AMBLE;
  const durationS = Math.floor(uni(r, 600, 1800));
  return {
    durationS, seed: 51000 + i, handset, tag: `${running ? 'run' : bodyOf === WALK ? 'walk' : 'amble'} ${kmh.toFixed(1)}km/h`,
    truth: mkTruth({ durationS, kmhAt: (t) => (t >= 60 ? kmh : 0) }),
    body: (t) => (t >= 60 ? bodyOf : DESK),
    noise: { sigma: uni(r, 1, 8), white: uni(r, 0, 4), accuracy: [3, uni(r, 8, 30)] },
  };
};
const d5 = fuzz('D5', 1500, mkWalk, noStart);
line(d5.bad === 0, `D5. On foot, ${d5.n} walks and runs (2.5-13 km/h, up to 30 min), every handset type`,
  `${d5.bad} trips started${d5.bad ? ' — ' + d5.firstBad.join('; ') : ''}`);
{
  // The hardest walker: no speed reading, a gait the accelerometer misses, Play Services silent.
  const all = Array.from({ length: d5.n }, (_, i) => mkWalk(i));
  const isHard = (cfg) => cfg.handset.doppler === 'none' && cfg.tag.startsWith('amble');
  const hard = all.filter(isHard);
  const now = d5.agg.filter((res, i) => res.started && isHard(all[i])).length;
  const old = hard.filter((cfg) => simulate({ ...cfg, gate: new LegacyStart() }).started).length;
  console.log(`  note    …including the ${hard.length} hardest: handset reports no speed, the accelerometer misses the gait, Play Services silent. Trips started: ${now} (previous logic: ${old}) — the classifier is no longer fed fix-to-fix speed, which read GPS noise as 15-20 km/h.`);
}

// D6 — far beyond the guarantee: error up to 130 m. Not pass/fail: the rate is the result.
{
  const n = 600;
  const res = fuzz('D6', n, mkParkedStress, noStart);
  const old = legacyStarts(n, mkParkedStress);
  console.log(`  stress  D6. Error up to 130 m (more than three times the field case), ${n} phones × 6 h: ${res.bad} phantom trips (${((res.bad / n) * 100).toFixed(1)}% of phones). The previous logic: ${old} (${((old / n) * 100).toFixed(0)}%)`);
}

if (LEGACY) {
  console.log('\n━━ The same randomised parked phones through the PREVIOUS logic ━━');
  const n = 300;
  const a = legacyStarts(n, mkParked);
  const b = legacyStarts(n, mkParked, { withDopplerVeto: true });
  const c = legacyStarts(n, mkRelocate);
  const e = legacyStarts(n, mkInsideTruth);
  console.log(`  D1 parked phones (error up to 60 m) that started a phantom trip — before: ${a}/${n} · with the 1 Oct patch: ${b}/${n} · now: ${d1.bad}/${d1.n}`);
  console.log(`  D2b fixes anywhere within 60 m, sensors lying — before: ${e}/${n} · now: ${d2b.bad}/${d2b.n}`);
  console.log(`  D3 relocations that started a phantom trip — before: ${c}/${n} · now: ${d3.bad}/${d3.n}`);
}

// ── The edge of what GPS alone can know ──
console.log('\n━━ Known limit (not a pass/fail) ━━');
{
  const res = simulate({
    durationS: 2 * H, truth: parkedTruth(2 * H), seed: 77, gate: new StartGate(),
    noise: { sigma: 3, white: 1, drift: { atS: 1800, kmh: 2, maxM: 400, ux: 1, uy: 0 } },
  });
  console.log(`  A still phone whose reported position WALKS 400 m away at 2 km/h, in steps, with good reported accuracy:`);
  console.log(`  ${res.started ? `a trip starts (${res.gate} gate, ${res.startDistM === 0 ? '' : ''}at ${res.atS}s)` : 'no trip'} — by GPS this is the same as a vehicle creeping out of a yard.`);
  console.log(`  (the motion classifier cannot veto it: its "moving with no gait" rule is fed by the same fixes.)`);
}

console.log(failed ? `\n${failed} START-GATE CHECK(S) FAILED` : '\nALL START-GATE SCENARIOS PASS');
process.exit(failed ? 1 : 0);
