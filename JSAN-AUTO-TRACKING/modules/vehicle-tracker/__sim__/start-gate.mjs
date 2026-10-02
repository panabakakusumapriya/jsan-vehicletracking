/**
 * JavaScript mirror of StartGate.kt — the rule that decides when an idle phone has really
 * departed. Same constants, same fields, same order of checks, so a scenario that passes here
 * passes against the logic the driver's phone runs. Change one, change the other.
 *
 * The only difference is geometry: positions here are local metres ({ x, y }) instead of
 * latitude/longitude, so distance is plain Euclidean rather than haversine. At the scale of a
 * 150 m circle the two agree to centimetres.
 *
 * Used by start-gate.sim.mjs (scenarios + fuzz) and by stop-logic.sim.mjs (whole-trip engine).
 */

export const START_RADIUS_M = 150.0;
export const DEPART_RADIUS_M = 50.0;
export const SETTLE_FIXES = 5;
export const SETTLE_QUORUM = 3;
export const EXIT_CONFIRM_FIXES = 3;
export const EXIT_CONFIRM_MS = 3_000;
export const EXIT_PENDING_MS = 120_000;
export const MAX_STEP_MPS = 70.0;
export const PROGRESS_STEP_M = 15.0;
export const PROGRESS_RETREAT_M = 30.0;
export const FALLBACK_GRACE_MS = 90_000;
export const PROGRESS_STALL_MS = 300_000;
export const RING_PROGRESS_MIN = 3;
export const PROGRESS_MIN = 6;
export const MOVING_KMH = 5.0;
export const MOVING_STREAK_MIN = 4;
export const DOPPLER_OK_HOLD_MS = 30_000;
export const FAST_MIN_KMH = 10.0;
export const FAST_CERTAIN_KMH = 20.0;
export const SLOW_MIN_KMH = 2.0;
export const VEHICLE_MIN_KMH = 0.8;
export const VEHICLE_MAX_ACCURACY_M = 25.0;
export const CORE_RADIUS_M = 20.0;
export const RING_STAY_RADIUS_M = 30.0;
export const RING_STAY_MISSES = 3;
export const RING_DWELL_MS = 300_000;
export const CORE_ORIGIN_MAX_GAP_MS = 180_000;
export const ORIGIN_MAX_GAP_MS = 90_000;

export const Decision = Object.freeze({
  NONE: 'NONE',
  START_FAST: 'START_FAST',
  START_SLOW: 'START_SLOW',
  START_VEHICLE: 'START_VEHICLE',
  REANCHOR: 'REANCHOR',
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (values) => [...values].sort((p, q) => p - q)[Math.floor(values.length / 2)];

export class StartGate {
  hasAnchor = false;
  exitConfirmed = false;
  wantsFastGps = false;
  lastDistM = 0.0;
  /** The last fix seen at rest: { pos, elapsedMs }. Mirror of restLat/restLon/restElapsedMs. */
  rest = { pos: { x: 0, y: 0 }, elapsedMs: 0 };
  /** The last fix seen within CORE_RADIUS_M of the anchor. Mirror of coreLat/coreLon/coreElapsedMs. */
  core = { pos: { x: 0, y: 0 }, elapsedMs: 0 };
  /** The last fix of a long stay in the ring, or null. Mirror of hasRingRest + ringRest*. */
  ringRest = null;
  #stayRef = null; // { pos, sinceMs }
  #stayMisses = 0;

  #anchor = { x: 0, y: 0 };
  #settleX = new Array(SETTLE_FIXES).fill(0);
  #settleY = new Array(SETTLE_FIXES).fill(0);
  #settleCount = 0;
  #outsideCount = 0;
  #firstOutsideMs = 0;
  #lastOutside = { x: 0, y: 0 };
  #lastOutsideMs = 0;
  #maxDistM = 0.0;
  #progressFixes = 0;
  #ringProgress = 0;
  #lastProgressMs = 0;
  #fallbackSinceMs = 0;
  #dopplerEverSeen = false;
  #movingStreak = 0;
  #dopplerOkUntilMs = 0;

  clear() {
    this.hasAnchor = false;
    this.exitConfirmed = false;
    this.wantsFastGps = false;
    this.lastDistM = 0.0;
    this.#settleCount = 0;
    this.#outsideCount = 0;
    this.#firstOutsideMs = 0;
    this.#maxDistM = 0.0;
    this.#progressFixes = 0;
    this.#ringProgress = 0;
    this.#lastProgressMs = 0;
    this.#fallbackSinceMs = 0;
    this.#movingStreak = 0;
    this.#dopplerOkUntilMs = 0;
    this.#stayRef = null;
    this.#stayMisses = 0;
    this.ringRest = null;
  }

  anchorAt(pos, now) {
    this.clear();
    this.hasAnchor = true;
    this.#anchor = { x: pos.x, y: pos.y };
    this.rest = { pos: { x: pos.x, y: pos.y }, elapsedMs: now };
    this.core = { pos: { x: pos.x, y: pos.y }, elapsedMs: now };
    this.#settleX[0] = pos.x;
    this.#settleY[0] = pos.y;
    this.#settleCount = 1;
  }

  /** For the sim's reporting only. */
  get anchor() { return this.#anchor; }

  /**
   * Mirror of StartGate.routeOrigin. `bufferElapsedMs`: the pre-start buffer's fix times,
   * oldest first. Returns { pos, elapsedMs, isRoutePoint }.
   */
  routeOrigin(bufferElapsedMs, now) {
    const fresh = (o) => {
      let next = now;
      for (const t of bufferElapsedMs) if (t > o.elapsedMs && t < now) { next = t; break; }
      return o.elapsedMs < now && next - o.elapsedMs <= ORIGIN_MAX_GAP_MS;
    };
    if (this.ringRest !== null) {
      return { pos: this.ringRest.pos, elapsedMs: this.ringRest.elapsedMs, isRoutePoint: fresh(this.ringRest) };
    }
    if (this.rest.elapsedMs - this.core.elapsedMs <= CORE_ORIGIN_MAX_GAP_MS && fresh(this.core)) {
      return { pos: this.core.pos, elapsedMs: this.core.elapsedMs, isRoutePoint: true };
    }
    return { pos: this.rest.pos, elapsedMs: this.rest.elapsedMs, isRoutePoint: fresh(this.rest) };
  }

  #tallyDoppler(now, dopplerKmh) {
    if (dopplerKmh === null || dopplerKmh === undefined) return;
    this.#dopplerEverSeen = true;
    if (dopplerKmh >= MOVING_KMH) {
      this.#movingStreak++;
      if (this.#movingStreak >= MOVING_STREAK_MIN) this.#dopplerOkUntilMs = now + DOPPLER_OK_HOLD_MS;
    } else {
      this.#movingStreak = 0;
    }
  }

  /**
   * One good idle fix. `dopplerKmh` is the receiver's own speed reading, or null when it
   * reports none.
   */
  onFix({
    now, pos, accuracyM, dopplerKmh, recentKmh,
    vehicleConfirmed, activitySaysVehicle, footRecently, gaitUsable, runningOnFoot,
  }) {
    this.wantsFastGps = false;
    if (!this.hasAnchor) {
      this.anchorAt(pos, now);
      this.#tallyDoppler(now, dopplerKmh);
      return Decision.NONE;
    }

    // ── Settle: a new anchor is one fix, and one fix can be wrong ──
    let justSettled = false;
    if (this.#settleCount > 0) {
      this.#settleX[this.#settleCount] = pos.x;
      this.#settleY[this.#settleCount] = pos.y;
      this.#settleCount++;
      if (this.#settleCount === SETTLE_FIXES) {
        const mid = { x: median(this.#settleX), y: median(this.#settleY) };
        let near = 0;
        for (let i = 0; i < SETTLE_FIXES; i++) {
          if (dist(mid, { x: this.#settleX[i], y: this.#settleY[i] }) < DEPART_RADIUS_M) near++;
        }
        this.#settleCount = 0;
        if (near >= SETTLE_QUORUM) {
          this.#anchor = mid;
          justSettled = true;
        }
      }
    }

    const d = dist(this.#anchor, pos);
    this.lastDistM = d;
    if (justSettled) {
      this.#outsideCount = 0;
      this.#firstOutsideMs = 0;
      this.exitConfirmed = false;
      this.#maxDistM = d;
      this.#progressFixes = 0;
      this.#ringProgress = 0;
    }

    this.#tallyDoppler(now, dopplerKmh);

    // ── A run that suddenly falls back: a blip, or over? ──
    const fellBack = this.#progressFixes > 0 && d < START_RADIUS_M &&
      (d < DEPART_RADIUS_M || d <= this.#maxDistM - PROGRESS_RETREAT_M);
    if (fellBack) {
      if (this.#fallbackSinceMs === 0) this.#fallbackSinceMs = now;
      if (now - this.#fallbackSinceMs <= FALLBACK_GRACE_MS) {
        this.#outsideCount = 0;
        this.#firstOutsideMs = 0;
        this.exitConfirmed = false;
        return Decision.NONE;
      }
    }
    this.#fallbackSinceMs = 0;

    // ── At rest: any departure in progress is over ──
    if (d < DEPART_RADIUS_M) {
      this.rest = { pos: { x: pos.x, y: pos.y }, elapsedMs: now };
      if (d < CORE_RADIUS_M) this.core = { pos: { x: pos.x, y: pos.y }, elapsedMs: now };
      this.#stayRef = null;
      this.#stayMisses = 0;
      this.ringRest = null;
      this.#outsideCount = 0;
      this.#firstOutsideMs = 0;
      this.exitConfirmed = false;
      this.#maxDistM = d;
      this.#progressFixes = 0;
      this.#ringProgress = 0;
      return Decision.NONE;
    }

    // ── Outward progress: stepping away, or wandering? ──
    if (this.#progressFixes > 0 && now - this.#lastProgressMs > PROGRESS_STALL_MS) {
      this.#maxDistM = d;
      this.#progressFixes = 0;
      this.#ringProgress = 0;
    }
    if (d <= this.#maxDistM - PROGRESS_RETREAT_M) {
      this.#maxDistM = d;
      this.#progressFixes = 0;
      this.#ringProgress = 0;
    } else if (d >= this.#maxDistM + PROGRESS_STEP_M) {
      this.#maxDistM = d;
      this.#progressFixes++;
      if (d < START_RADIUS_M) this.#ringProgress++;
      this.#lastProgressMs = now;
      this.wantsFastGps = true;
    }

    // ── In the ring: left the rest spot, still inside the circle ──
    if (d < START_RADIUS_M) {
      this.#outsideCount = 0;
      this.#firstOutsideMs = 0;
      this.exitConfirmed = false;
      // A long stay in one spot of the ring (walked to the vehicle, sat in it): the route of
      // whatever leaves next begins at the end of that stay. The anchor does not move.
      if (this.#stayRef !== null && dist(this.#stayRef.pos, pos) <= RING_STAY_RADIUS_M) {
        this.#stayMisses = 0;
        if (now - this.#stayRef.sinceMs >= RING_DWELL_MS) {
          this.ringRest = { pos: { x: pos.x, y: pos.y }, elapsedMs: now };
        }
      } else if (this.#stayRef === null || ++this.#stayMisses >= RING_STAY_MISSES) {
        // Several fixes in a row away from the spot: it has moved on (one stray fix has not).
        this.#stayRef = { pos: { x: pos.x, y: pos.y }, sinceMs: now };
        this.#stayMisses = 0;
      }
      return Decision.NONE;
    }

    // ── Outside the circle ──
    this.wantsFastGps = true;
    if (this.#outsideCount > 0) {
      const stepSec = Math.max(1.0, (now - this.#lastOutsideMs) / 1000.0);
      if (dist(this.#lastOutside, pos) / stepSec > MAX_STEP_MPS) {
        this.#outsideCount = 0;
        this.exitConfirmed = false;
      }
    }
    if (this.#outsideCount === 0) this.#firstOutsideMs = now;
    this.#outsideCount++;
    this.#lastOutside = { x: pos.x, y: pos.y };
    this.#lastOutsideMs = now;
    if (this.#outsideCount < EXIT_CONFIRM_FIXES || now - this.#firstOutsideMs < EXIT_CONFIRM_MS) {
      return Decision.NONE;
    }
    this.exitConfirmed = true;

    // Speed since the phone was last at rest: a baseline of 100 m or more.
    const legSec = Math.max(0.1, (now - this.rest.elapsedMs) / 1000.0);
    const legKmh = (dist(this.rest.pos, pos) / legSec) * 3.6;

    const dopplerOk = now <= this.#dopplerOkUntilMs;
    const progressOk = this.#ringProgress >= RING_PROGRESS_MIN || this.#progressFixes >= PROGRESS_MIN;
    const fastCorroborated = dopplerOk || (!this.#dopplerEverSeen && progressOk);
    const crawlCorroborated = dopplerOk || progressOk;

    const fast = legKmh >= FAST_MIN_KMH && fastCorroborated &&
      (vehicleConfirmed || legKmh >= FAST_CERTAIN_KMH || (gaitUsable && !runningOnFoot));
    const slow = legKmh >= SLOW_MIN_KMH && crawlCorroborated && !footRecently &&
      (vehicleConfirmed || activitySaysVehicle);
    const vehicle = vehicleConfirmed && crawlCorroborated &&
      accuracyM <= VEHICLE_MAX_ACCURACY_M && recentKmh >= VEHICLE_MIN_KMH;
    // Sim-only diagnostics (no counterpart in StartGate.kt): why a confirmed exit did or did not start.
    this.lastEval = { legKmh, dopplerOk, progressOk, ring: this.#ringProgress, prog: this.#progressFixes, d };

    if (fast) return Decision.START_FAST;
    if (slow) return Decision.START_SLOW;
    if (vehicle) return Decision.START_VEHICLE;

    if (now - this.#firstOutsideMs >= EXIT_PENDING_MS) {
      this.anchorAt(pos, now);
      return Decision.REANCHOR;
    }
    return Decision.NONE;
  }
}

/**
 * The PREVIOUS start logic (TrackingService.kt as of 2026-10-01, before StartGate) — kept only so
 * the simulation can run the same inputs through both and show what changed. Three gates measured
 * from a watch anchor: fast 30 m at 10 km/h, slow 100 m at 2 km/h, vehicle 20 m with a verdict.
 * `withDopplerVeto` adds the 2026-10-01 patch (fast gate needs two Doppler fixes at 5 km/h).
 */
export class LegacyStart {
  #watch = null;
  #watchMs = 0;
  #dopplerSeen = false;
  #dopplerMoving = 0;
  constructor({ withDopplerVeto = false } = {}) { this.withDopplerVeto = withDopplerVeto; }

  anchorAt(pos, now) { this.#anchor(pos, now, null); }
  clear() { this.#watch = null; }
  // The flush and cadence hooks the sim calls on whichever gate it is running.
  exitConfirmed = false;
  wantsFastGps = false;
  /** The previous flush took every buffered fix since the watch was anchored, and no origin point. */
  routeOrigin() { return { pos: this.#watch ?? { x: 0, y: 0 }, elapsedMs: this.#watchMs - 1, isRoutePoint: false }; }
  get anchor() { return this.#watch ?? { x: 0, y: 0 }; }
  #anchor(pos, now, doppler) {
    this.#watch = { x: pos.x, y: pos.y };
    this.#watchMs = now;
    this.#dopplerSeen = doppler !== null && doppler !== undefined;
    this.#dopplerMoving = this.#dopplerSeen && doppler >= 5 ? 1 : 0;
  }

  onFix({
    now, pos, accuracyM, dopplerKmh, recentKmh,
    vehicleConfirmed, activitySaysVehicle, footRecently, gaitUsable, runningOnFoot,
  }) {
    if (this.#watch === null) { this.#anchor(pos, now, dopplerKmh); return Decision.NONE; }
    if (dopplerKmh !== null && dopplerKmh !== undefined) {
      this.#dopplerSeen = true;
      if (dopplerKmh >= 5) this.#dopplerMoving++;
    }
    const d = dist(this.#watch, pos);
    const speedGateReach = d >= Math.max(30, accuracyM * 1.5);
    const vehicleGateReach = d >= Math.max(20, accuracyM * 2);
    if (!speedGateReach && !vehicleGateReach) return Decision.NONE;

    const avgKmh = (d / Math.max(0.1, (now - this.#watchMs) / 1000)) * 3.6;
    const dopplerAgrees = !this.withDopplerVeto || !this.#dopplerSeen || this.#dopplerMoving >= 2;
    const fast = speedGateReach && avgKmh >= 10 && dopplerAgrees &&
      (vehicleConfirmed || avgKmh >= 20 || (gaitUsable && !runningOnFoot));
    const slow = speedGateReach && avgKmh >= 2 && d >= 100 && !footRecently &&
      (vehicleConfirmed || activitySaysVehicle);
    const vehicle = vehicleConfirmed && vehicleGateReach && accuracyM <= 25 && recentKmh >= 0.8;
    if (fast) return Decision.START_FAST;
    if (slow) return Decision.START_SLOW;
    if (vehicle) return Decision.START_VEHICLE;

    if (this.withDopplerVeto && speedGateReach && avgKmh >= 10 && this.#dopplerSeen && this.#dopplerMoving === 0) {
      this.#anchor(pos, now, dopplerKmh);
    } else if (speedGateReach && avgKmh < 2 && !(vehicleConfirmed && recentKmh >= 0.8)) {
      this.#anchor(pos, now, dopplerKmh);
    }
    return Decision.NONE;
  }
  get exitConfirmed() { return false; }
  get wantsFastGps() { return false; }
}
