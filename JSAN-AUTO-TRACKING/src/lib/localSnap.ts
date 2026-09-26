/**
 * On-device map matching — the driver's own answer to "which streets have I driven", the moment
 * they drive them.
 *
 * Why this exists
 * ---------------
 * The audited answer is Valhalla's, computed server-side once a trip closes; it decides UKM and
 * therefore pay, and nothing here competes with it. But a driver standing at a junction deciding
 * "do I take that red street or have I already done it?" needs the answer NOW, and the server's
 * answer is minutes-to-hours away. A map that only recolours at end of shift is a map the driver
 * stops trusting, and an untrusted map gets streets driven twice and streets missed.
 *
 * What this replaces, and why it was not good enough
 * -------------------------------------------------
 * The previous pass marked a link covered when ANY recorded fix landed within 25 m of it. Three
 * things were wrong with that, all of them visible to a driver:
 *   - it is proximity, not matching. At 25 m in a suburban grid, driving one street marks the
 *     parallel street, the cross street you stopped at, and the carriageway on the other side of
 *     a divided road. Blue appears where nobody drove.
 *   - it marks WHOLE links. Turning 40 m into a 1.4 km road painted the whole road blue, so the
 *     other 1.36 km never got driven — a real coverage loss caused by the display.
 *   - it only ever considered UNCOVERED links as candidates, so driving down an already-blue road
 *     attributed the fix to whatever red road happened to be nearest.
 *
 * What this does instead
 * ----------------------
 * Proper (small) map matching: candidates within a tight buffer, filtered by whether the road
 * actually points the way the vehicle is going, resolved with a preference for staying on the
 * link we were already on, and accumulated as COVERED ARC INTERVALS along each link rather than a
 * boolean. Blue grows along the road as it is driven, and stops where the driver stopped.
 *
 * Deliberately NOT here: any notion of pay, UKM, or "the network is n% done". Those are the
 * server's, computed from the audited match. This is a driver-awareness layer and its numbers
 * never leave the phone.
 *
 * Pure: no React, no Expo, no react-native. That is what lets
 * `__sim__/local-snap.sim.mjs` import and score THIS module rather than a hand-kept copy of it —
 * the two cannot drift, because there is only one of them. Persistence lives next door in
 * localSnapStore.ts, which is the part that needs a filesystem.
 */

/** One road exactly as GET /api/tracking/my-roads puts it on the wire. */
export type RoadTuple = [string, number, 0 | 1, [number, number][]];

/* ── tuning ─────────────────────────────────────────────────────────────────── */

/** Grid cell for the spatial index, in degrees (~220 m). Big enough that a fix's 3×3
 *  neighbourhood always contains every candidate within the buffer, small enough that the
 *  neighbourhood is a few dozen segments rather than a few thousand. */
const CELL_DEG = 0.002;

/**
 * The buffer, in metres. A road centreline within this distance of the vehicle is a candidate
 * for "we are on it".
 *
 * 11 m is a deliberate choice, not a fitted one: it is about one lane either side of the
 * centreline plus a little, so it accepts the road you are on and rejects the one across the
 * median. Widening it is how the old 25 m version ended up painting parallel streets.
 */
export const SNAP_BUFFER_M = 11;

/**
 * How far the buffer may stretch when the fix itself is poor.
 *
 * A hard 11 m against a fix reporting 20 m of error would simply stop matching under tree cover
 * and in street canyons — exactly where a driver most wants to know what they have done. So the
 * radius grows with the reported accuracy, to this cap. The heading test below is what keeps
 * that stretch from turning into the old proximity behaviour: a wider search still cannot accept
 * a road pointing the wrong way.
 */
const ACCURACY_CAP_M = 24;

/**
 * How far a road's bearing may differ from the vehicle's before it stops being a candidate,
 * in degrees, folded to 0–90 (a two-way road driven in either direction is the same road).
 *
 * 60° is loose on purpose. Bearing is usually DERIVED from the previous fix ~10 m back, and at
 * 10 m with a few metres of GPS noise the derived bearing can be 30–40° out on a straight road.
 * The job here is not precision — it is throwing out the cross street at 90°, the bridge over
 * the road below, and the slip lane heading the other way.
 */
const HEADING_TOLERANCE_DEG = 60;

/** Below this combined score nothing is claimed: the vehicle is treated as off-network, which
 *  is a real and common state (car parks, private roads, a network that stops at the boundary). */
const MIN_SCORE = 0.2;

/** Staying on the link we matched last time is worth this much score. Roads run parallel and
 *  cross constantly; without hysteresis a single noisy fix hops to the neighbour and paints it. */
const CONTINUITY_BONUS = 0.35;

/**
 * How much wider the search is for the link we are ALREADY on.
 *
 * GPS error is not independent from fix to fix. Under a tree line or between buildings it sits
 * 10–15 m off to one side for half a minute and then drifts back, and for that half minute the
 * true road is further away than the parallel street. A single radius makes the road we are
 * demonstrably driving stop being a candidate at all, at which point the bonus above has nothing
 * to apply to and the matcher walks onto the neighbour — which is precisely what drivers were
 * seeing.
 *
 * Widening only the incumbent keeps it in the running without making it win: a genuinely nearer
 * road still scores higher and still takes over, because its own distance is measured against
 * the tight radius. This is the cheap form of what a full HMM matcher expresses as a transition
 * probability, and it is the single change that matters most on real traces.
 */
const STICKY_RADIUS_FACTOR = 2.4;

/**
 * The continuity bonus is paid IN FULL only while the incumbent is within the ordinary buffer,
 * and fades to nothing across the widened band.
 *
 * Without the fade, stickiness becomes a latch: a flat bonus plus a wide radius lets the road we
 * were on out-score a road the vehicle is sitting exactly on top of, and once the match has
 * hopped to the parallel street by mistake that street inherits the stickiness and keeps
 * painting for as long as the drift lasts. Measured on the drift scenarios, a flat bonus worked
 * at STICKY_RADIUS_FACTOR 2.2–2.4 and collapsed at 2.6 — worst-case bleed 43 m became 276 m — so
 * the tuning was balanced on an edge.
 *
 * Together with scoring distance against the tight buffer (see matchFix) the fade removes that
 * edge entirely: the rubric now scores the same at every combination of bonus 0.35–0.50 and
 * sticky factor 2.4–4.0, which is the difference between a number that is right and a number
 * that happens to be lucky.
 */
function continuityBonus(dist: number, radius: number, stickyRadius: number): number {
  if (dist <= radius) return CONTINUITY_BONUS;
  const span = stickyRadius - radius;
  if (span <= 0) return CONTINUITY_BONUS;
  return CONTINUITY_BONUS * Math.max(0, (stickyRadius - dist) / span);
}

/**
 * How many consecutive fixes must agree before the match actually moves to a different link.
 *
 * Scoring one fix at a time cannot tell a turn from a drift excursion — both look like "the
 * other road is nearer now". Time can: a turn keeps winning, an excursion does not. Holding the
 * switch until it has been corroborated (~30 m of travel) means a momentary wander paints nothing at all on
 * the neighbour. A real turn is barely delayed at all — one fix, measured — because the road being
 * left stops being a candidate the moment it is behind you, which takes the override below.
 *
 * This is NOT a score margin. A margin was tried and removed: it applies to whichever link is
 * currently held, so when the held link is the wrong one the margin defends the error and the
 * match never comes back. A confirmation count re-decides from raw scores every fix, so it can
 * delay a mistake but never entrench one. The incumbent is also overridden immediately when it
 * stops being a candidate at all — refusing to leave a road the vehicle has demonstrably left
 * would be worse than switching early.
 */
const SWITCH_CONFIRM_FIXES = 3;

/** Fraction of a link's length that must be covered before it is called done and drawn as a
 *  whole link. Short of 100% because the last few metres at each end belong to the junction and
 *  are rarely sampled — holding out for them would leave every finished street looking unfinished. */
const FULL_LINK_FRACTION = 0.85;

/** How far past a matched point to paint when there is no previous match to join to — half the
 *  service's ~10 m recording spacing, so an isolated fix paints roughly what it saw and no more. */
const ISOLATED_PAINT_M = 6;

/** Crossing a junction: how close the previous/current fix must be to a link's end before the
 *  gap to that end is painted in. Without this every turn leaves an unpainted notch. */
const JUNCTION_BRIDGE_M = 30;

/**
 * Sanity bound when joining two fixes on the same link. The along-road distance may legitimately
 * exceed the straight-line distance (the road bends between them), but not by much. A GPS jump
 * that lands further along a horseshoe would otherwise paint the entire horseshoe.
 */
const ALONG_SLACK_FACTOR = 1.6;
const ALONG_SLACK_M = 15;

/**
 * When two consecutive fixes may be JOINED — i.e. when the road between them can be claimed as
 * driven rather than merely inferred.
 *
 * Speed, not distance, is the test. The recording rule in TrackingService mints a point every
 * ~10 m, so a 200 m gap between fixes is never normal spacing — but at 110 km/h with a provider
 * emitting once every few seconds it can legitimately happen, and refusing to join there would
 * leave a motorway painted as dashes. What cannot happen is covering that ground faster than a
 * vehicle moves, which is the signature of multipath; the service drops those at the same 180
 * km/h threshold, and this repeats the check because JS can miss events the service never sent.
 *
 * The distance backstop covers the case with no timestamps at all, and outages long enough (a
 * tunnel, a dead battery) that whatever happened in between was genuinely not observed.
 */
const MAX_JOIN_SPEED_KMH = 180;
const MAX_JOIN_GAP_M = 250;

/* ── geometry ───────────────────────────────────────────────────────────────── */

/**
 * Metres per degree at a latitude. Planar maths is used throughout: over the ~200 m a single
 * match ever looks at, the difference from proper spherical distance is under a centimetre, and
 * this runs per GPS fix on a phone.
 */
function scaleAt(lat: number): { mx: number; my: number } {
  return { mx: 111320 * Math.cos((lat * Math.PI) / 180), my: 110540 };
}

function distM(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const { mx, my } = scaleAt(aLat);
  const dx = (bLon - aLon) * mx;
  const dy = (bLat - aLat) * my;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Compass bearing a→b in degrees, 0 = north. */
function bearingDeg(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const { mx, my } = scaleAt(aLat);
  const dx = (bLon - aLon) * mx;
  const dy = (bLat - aLat) * my;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Difference between two bearings, folded to 0–90: a two-way road driven either way agrees. */
function headingDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  if (d > 90) d = 180 - d;
  return d;
}

/* ── index ──────────────────────────────────────────────────────────────────── */

export type LinkRec = {
  id: string;
  coords: [number, number][];
  /** Cumulative metres at each vertex; cum[last] is the link's length. */
  cum: number[];
  len: number;
  /**
   * May this link be PAINTED by a local match?
   *
   * False for links the server already reports covered. They stay in the index as match
   * candidates — that is the whole point, so that driving an already-blue road is attributed to
   * the road it happened on instead of the nearest red one — but there is nothing to paint.
   */
  markable: boolean;
};

export type SnapIndex = {
  links: LinkRec[];
  /** cell key -> packed segment refs (linkIndex * 4096 + vertexIndex). */
  cells: Map<string, number[]>;
  segCount: number;
};

/** Segment refs are packed into one number to keep the grid a Map of plain number arrays.
 *  4096 vertices per link is far beyond anything the server emits (links are street blocks). */
const VERT_BITS = 4096;

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function addLinkToIndex(index: SnapIndex, link: LinkRec, linkIndex: number): void {
  const { coords } = link;
  for (let v = 0; v + 1 < coords.length && v < VERT_BITS; v++) {
    const [ax, ay] = coords[v];
    const [bx, by] = coords[v + 1];
    const ref = linkIndex * VERT_BITS + v;
    const minX = Math.floor(Math.min(ax, bx) / CELL_DEG);
    const maxX = Math.floor(Math.max(ax, bx) / CELL_DEG);
    const minY = Math.floor(Math.min(ay, by) / CELL_DEG);
    const maxY = Math.floor(Math.max(ay, by) / CELL_DEG);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cy = minY; cy <= maxY; cy++) {
        const k = cellKey(cx, cy);
        const bucket = index.cells.get(k);
        if (bucket) bucket.push(ref);
        else index.cells.set(k, [ref]);
      }
    }
    index.segCount++;
  }
}

function toLinkRec(r: RoadTuple): LinkRec | null {
  const coords = r[3];
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const clean: [number, number][] = [];
  for (const c of coords) {
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    clean.push([c[0], c[1]]);
  }
  if (clean.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    cum.push(cum[i - 1] + distM(clean[i - 1][0], clean[i - 1][1], clean[i][0], clean[i][1]));
  }
  const len = cum[cum.length - 1];
  if (!(len > 0)) return null;
  return { id: r[0], coords: clean, cum, len, markable: r[2] !== 1 };
}

export function buildSnapIndex(roads: RoadTuple[]): SnapIndex {
  const index: SnapIndex = { links: [], cells: new Map(), segCount: 0 };
  for (const r of roads) {
    const link = toLinkRec(r);
    if (!link) continue;
    index.links.push(link);
    addLinkToIndex(index, link, index.links.length - 1);
  }
  return index;
}

/**
 * Cooperative build. A full assignment is up to 20,000 links / ~200,000 segments, and doing that
 * in one go blocks the JS thread long enough to drop the map's first frames. Yields between
 * batches so first paint stays fluid; the index simply is not ready for the first second or two,
 * which costs at most the first couple of fixes of a shift.
 */
export async function buildSnapIndexAsync(
  roads: RoadTuple[],
  isCancelled: () => boolean = () => false,
): Promise<SnapIndex | null> {
  const index: SnapIndex = { links: [], cells: new Map(), segCount: 0 };
  const BATCH = 250;
  for (let start = 0; start < roads.length; start += BATCH) {
    if (isCancelled()) return null;
    const end = Math.min(roads.length, start + BATCH);
    for (let i = start; i < end; i++) {
      const link = toLinkRec(roads[i]);
      if (!link) continue;
      index.links.push(link);
      addLinkToIndex(index, link, index.links.length - 1);
    }
    if (end < roads.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return isCancelled() ? null : index;
}

/* ── matching ───────────────────────────────────────────────────────────────── */

export type Fix = {
  lon: number;
  lat: number;
  /** Device-reported bearing, degrees. Null when the service did not supply one — then the
   *  bearing from the previous fix is used, and failing that the heading test is skipped. */
  bearing?: number | null;
  /** Device-reported accuracy in metres. Null widens nothing; the buffer stays at its tight value. */
  accuracy?: number | null;
  /** The trip this fix belongs to. Coverage is grouped by it so the server's verdict for one
   *  trip can replace exactly that trip's guesses and leave the rest alone. */
  tripId?: string | null;
  /** When the fix was taken, epoch ms. Used only to tell a fast vehicle from a GPS glitch. */
  atMs?: number | null;
};

export type Match = { linkIndex: number; s: number; dist: number; score: number };

export type Matcher = {
  index: SnapIndex;
  prev: {
    lon: number; lat: number; linkIndex: number; s: number;
    tripId: string | null; atMs: number | null;
  } | null;
  /** A proposed move to another link, and how many fixes have backed it. See
   *  SWITCH_CONFIRM_FIXES. Mutated by matchFix, which is why it is called once per fix. */
  pending: { linkIndex: number; count: number } | null;
};

export function createMatcher(index: SnapIndex): Matcher {
  return { index, prev: null, pending: null };
}

/**
 * Nearest point on one segment, as a fraction along it plus the distance to it.
 * Coordinates are pre-scaled to metres relative to the query point by the caller.
 */
function segNearest(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): { t: number; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return { t, dist: Math.hypot(px - qx, py - qy) };
}

/**
 * Best link for one fix, or null when nothing on the network fits.
 *
 * Returning null is a real answer, not a failure: car parks, depots, private property and the
 * ground outside the delivered network all produce it, and inventing a match there is how a map
 * ends up claiming streets that were never driven.
 */
export function matchFix(m: Matcher, fix: Fix): Match | null {
  const { index } = m;
  if (!index.links.length) return null;
  if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) return null;

  const acc = typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy) ? fix.accuracy : 0;
  const radius = Math.max(SNAP_BUFFER_M, Math.min(acc, ACCURACY_CAP_M));

  // Bearing: the device's if it gave one, otherwise inferred from the previous fix — but only
  // when the vehicle actually moved far enough for the inference to mean anything. Two fixes 2 m
  // apart produce a bearing that is pure noise, and a noisy bearing is worse than none.
  let bearing: number | null = null;
  if (typeof fix.bearing === 'number' && Number.isFinite(fix.bearing)) {
    bearing = fix.bearing;
  } else if (m.prev) {
    const moved = distM(m.prev.lon, m.prev.lat, fix.lon, fix.lat);
    if (moved >= 6) bearing = bearingDeg(m.prev.lon, m.prev.lat, fix.lon, fix.lat);
  }

  const { mx, my } = scaleAt(fix.lat);
  const cx = Math.floor(fix.lon / CELL_DEG);
  const cy = Math.floor(fix.lat / CELL_DEG);
  const prevLink = m.prev ? m.prev.linkIndex : -1;

  let best: Match | null = null;
  /** Best candidate on the link we were already on, kept so a switch can be made to earn it. */
  let bestIncumbent: Match | null = null;
  // One segment can sit in several grid cells; scoring it twice is waste, not a wrong answer.
  const seen = new Set<number>();

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.cells.get(cellKey(cx + dx, cy + dy));
      if (!bucket) continue;
      for (const ref of bucket) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        const li = Math.floor(ref / VERT_BITS);
        const vi = ref % VERT_BITS;
        const link = index.links[li];
        const a = link.coords[vi];
        const b = link.coords[vi + 1];
        const ax = (a[0] - fix.lon) * mx;
        const ay = (a[1] - fix.lat) * my;
        const bx = (b[0] - fix.lon) * mx;
        const by = (b[1] - fix.lat) * my;
        const isIncumbent = li === prevLink;
        // The road we are already on keeps a wider search; everything else is judged on the
        // tight buffer. See STICKY_RADIUS_FACTOR.
        const localRadius = isIncumbent ? radius * STICKY_RADIUS_FACTOR : radius;
        const near = segNearest(0, 0, ax, ay, bx, by);
        if (near.dist > localRadius) continue;

        // Does this road point the way we are going? Skipped when there is no trustworthy
        // bearing — better to fall back on distance alone than to filter on noise.
        let headScore = 0.6;
        if (bearing !== null) {
          const segBearing = bearingDeg(a[0], a[1], b[0], b[1]);
          const delta = headingDelta(bearing, segBearing);
          if (delta > HEADING_TOLERANCE_DEG) continue;
          headScore = 1 - delta / 90;
        }

        /**
         * Distance is scored against the TIGHT buffer for every candidate, including the
         * incumbent, and floors at zero beyond it. The widened radius decides who is considered,
         * never how well they score — scoring the incumbent against its own generous radius is
         * what let a road 20 m away out-rank one the vehicle was sitting on top of.
         *
         * This makes the no-latch property arithmetic rather than tuning: the most continuity
         * can ever be worth (0.35) is less than the distance advantage of being exactly on a
         * road versus outside the buffer (0.55), so a road under the wheels always wins. That
         * holds at any STICKY_RADIUS_FACTOR, which is why there is no cliff to sit next to.
         */
        const distScore = Math.max(0, 1 - near.dist / radius);
        const score = 0.55 * distScore + 0.45 * headScore
          + (isIncumbent ? continuityBonus(near.dist, radius, localRadius) : 0);
        const segLen = link.cum[vi + 1] - link.cum[vi];
        const cand: Match = {
          linkIndex: li, s: link.cum[vi] + near.t * segLen, dist: near.dist, score,
        };
        if (isIncumbent && (!bestIncumbent || score > bestIncumbent.score)) bestIncumbent = cand;
        if (!best || score > best.score) best = cand;
      }
    }
  }

  if (!best || best.score < MIN_SCORE) {
    m.pending = null;
    return null;
  }

  // A move to a different link waits for corroboration, unless the road we were on is no longer
  // a candidate at all — see SWITCH_CONFIRM_FIXES.
  if (prevLink >= 0 && best.linkIndex !== prevLink) {
    if (m.pending && m.pending.linkIndex === best.linkIndex) m.pending.count += 1;
    else m.pending = { linkIndex: best.linkIndex, count: 1 };
    if (m.pending.count < SWITCH_CONFIRM_FIXES && bestIncumbent
      && bestIncumbent.score >= MIN_SCORE) {
      return bestIncumbent;
    }
  } else {
    m.pending = null;
  }

  return best;
}

/* ── covered arc intervals ──────────────────────────────────────────────────── */

/**
 * What has been driven, grouped by trip.
 *
 * Grouped rather than flat because of the handover: when the server finishes attributing trip T,
 * its verdict replaces this phone's guesses for T and ONLY for T. A flat set would force a
 * choice between throwing away guesses for trips still in the queue (streets flick back to red,
 * which is exactly the confusion this feature exists to remove) and keeping stale guesses
 * forever.
 *
 * Intervals are metres along the link, stored flat and merged: [s0, e0, s1, e1, ...].
 *
 * Trips are keyed by the CLIENT trip id — the UUID the tracking service mints at trip start and
 * stamps on every fix. It is the only id the phone ever holds; the server's own id never reaches
 * the handset, and the server answers "is this trip finished?" by the client id for that reason.
 *
 * `touchedAt` is when each trip last painted anything. Expiry is per trip and measured from that,
 * not from when the file was last written — a whole-file timestamp is renewed by every save, so
 * a week-old guess would ride along forever behind today's driving.
 */
export type CoverStore = {
  byTrip: Map<string, Map<string, number[]>>;
  touchedAt: Map<string, number>;
};

export function createCoverStore(): CoverStore {
  return { byTrip: new Map(), touchedAt: new Map() };
}

/** Trip ids this phone is still holding guesses for. */
export function coverTripIds(store: CoverStore): string[] {
  return [...store.byTrip.keys()];
}

/**
 * Retire guesses nobody has settled in time.
 *
 * The normal exit for a guess is the server's verdict (dropTrip). This is the backstop for the
 * cases where no verdict ever comes: a match that failed and was never retried, a trip whose
 * points never reached the server. A guess is a display of "you drove here recently"; after a day
 * and a half it is neither recent nor, without the server's word, trustworthy.
 */
export function expireTrips(store: CoverStore, now: number, ttlMs: number): boolean {
  let changed = false;
  for (const tripId of [...store.byTrip.keys()]) {
    const at = store.touchedAt.get(tripId) ?? 0;
    if (now - at > ttlMs) {
      store.byTrip.delete(tripId);
      store.touchedAt.delete(tripId);
      changed = true;
    }
  }
  return changed;
}

const NO_TRIP = '_';

/** Merge [s, e] into a sorted, non-overlapping flat interval list. Returns true if it changed. */
export function addInterval(list: number[], s: number, e: number): boolean {
  if (!(e > s)) return false;
  let lo = s;
  let hi = e;
  const out: number[] = [];
  let changed = false;
  let inserted = false;
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i];
    const b = list[i + 1];
    if (b < lo) { out.push(a, b); continue; }
    if (a > hi) {
      if (!inserted) { out.push(lo, hi); inserted = true; }
      out.push(a, b);
      continue;
    }
    // Overlaps or touches — absorb it.
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  if (!inserted) out.push(lo, hi);
  // Sorted insert above can leave the new interval out of order only if list was unsorted, which
  // it never is — everything here goes through this function.
  if (out.length !== list.length) changed = true;
  else {
    for (let i = 0; i < out.length; i++) if (out[i] !== list[i]) { changed = true; break; }
  }
  if (changed) {
    list.length = 0;
    for (const v of out) list.push(v);
  }
  return changed;
}

export function intervalsLength(list: number[]): number {
  let total = 0;
  for (let i = 0; i < list.length; i += 2) total += list[i + 1] - list[i];
  return total;
}

function paint(
  store: CoverStore, tripId: string, linkId: string, len: number, s: number, e: number,
): boolean {
  const lo = Math.max(0, Math.min(s, e));
  const hi = Math.min(len, Math.max(s, e));
  if (!(hi > lo)) return false;
  let perTrip = store.byTrip.get(tripId);
  if (!perTrip) { perTrip = new Map(); store.byTrip.set(tripId, perTrip); }
  let list = perTrip.get(linkId);
  if (!list) { list = []; perTrip.set(linkId, list); }
  return addInterval(list, lo, hi);
}

/**
 * Feed one recorded fix in. Returns true when the painted picture actually changed, so the
 * caller can avoid a re-render for the many fixes that tell it nothing new — a parked vehicle
 * emits a fix every few seconds and none of them move anything.
 */
export function ingestFix(m: Matcher, store: CoverStore, fix: Fix): boolean {
  const match = matchFix(m, fix);
  const tripId = fix.tripId || NO_TRIP;

  if (!match) {
    // Off-network. The previous position is still worth remembering for the next bearing, but
    // the link continuity is broken — the next match must not paint a line back to wherever we
    // were before the car park.
    m.prev = null;
    return false;
  }

  const link = m.index.links[match.linkIndex];
  const prevRaw = m.prev;
  let changed = false;

  /**
   * Is the previous fix close enough in time and space that the ground between them counts as
   * driven? When it is not — a glitch, a tunnel, the app waking after an outage — the fix is
   * still matched and still painted, but only around itself: the stretch back to wherever we
   * last were was not observed, and claiming it is how one bad fix paints a whole street.
   */
  let prev = prevRaw;
  if (prev) {
    const gap = distM(prev.lon, prev.lat, fix.lon, fix.lat);
    let plausible = gap <= MAX_JOIN_GAP_M;
    if (plausible && typeof fix.atMs === 'number' && typeof prev.atMs === 'number') {
      const dtMs = fix.atMs - prev.atMs;
      if (dtMs > 0) plausible = (gap / (dtMs / 1000)) * 3.6 <= MAX_JOIN_SPEED_KMH;
    }
    if (!plausible) prev = null;
  }

  if (link.markable) {
    if (prev && prev.linkIndex === match.linkIndex && prev.tripId === tripId) {
      // Same link, same trip: the vehicle drove the stretch between the two projections. Guard
      // against a GPS jump painting a whole horseshoe by insisting the along-road distance is
      // roughly consistent with how far the vehicle actually moved.
      const along = Math.abs(match.s - prev.s);
      const straight = distM(prev.lon, prev.lat, fix.lon, fix.lat);
      if (along <= straight * ALONG_SLACK_FACTOR + ALONG_SLACK_M) {
        changed = paint(store, tripId, link.id, link.len, prev.s, match.s) || changed;
      } else {
        changed = paint(store, tripId, link.id, link.len,
          match.s - ISOLATED_PAINT_M / 2, match.s + ISOLATED_PAINT_M / 2) || changed;
      }
    } else {
      // Arrived on this link. Paint from whichever end we came in by, when that end is close
      // enough to where we just were to be the junction we turned at.
      const startGap = distM(link.coords[0][0], link.coords[0][1], fix.lon, fix.lat);
      const endGap = distM(
        link.coords[link.coords.length - 1][0], link.coords[link.coords.length - 1][1],
        fix.lon, fix.lat,
      );
      if (startGap <= JUNCTION_BRIDGE_M && startGap <= endGap) {
        changed = paint(store, tripId, link.id, link.len, 0, match.s) || changed;
      } else if (endGap <= JUNCTION_BRIDGE_M) {
        changed = paint(store, tripId, link.id, link.len, match.s, link.len) || changed;
      } else {
        changed = paint(store, tripId, link.id, link.len,
          match.s - ISOLATED_PAINT_M / 2, match.s + ISOLATED_PAINT_M / 2) || changed;
      }
    }
  }

  // Leaving a link: close it out to the junction we left by, so a turn does not leave a notch.
  if (prev && prev.linkIndex !== match.linkIndex) {
    const left = m.index.links[prev.linkIndex];
    if (left.markable && prev.tripId === tripId) {
      const toStart = distM(left.coords[0][0], left.coords[0][1], fix.lon, fix.lat);
      const toEnd = distM(
        left.coords[left.coords.length - 1][0], left.coords[left.coords.length - 1][1],
        fix.lon, fix.lat,
      );
      if (toEnd <= JUNCTION_BRIDGE_M && toEnd <= toStart) {
        changed = paint(store, tripId, left.id, left.len, prev.s, left.len) || changed;
      } else if (toStart <= JUNCTION_BRIDGE_M) {
        changed = paint(store, tripId, left.id, left.len, 0, prev.s) || changed;
      }
    }
  }

  m.prev = {
    lon: fix.lon, lat: fix.lat, linkIndex: match.linkIndex, s: match.s, tripId,
    atMs: typeof fix.atMs === 'number' ? fix.atMs : null,
  };
  // The phone's clock, not the fix's: expiry compares against Date.now(), and a GPS timestamp
  // can sit hours off on a device whose clock was never set.
  if (changed) store.touchedAt.set(tripId, Date.now());
  return changed;
}

/**
 * The server has spoken for this trip: drop the phone's guesses for it.
 *
 * Called once the server reports the trip settled AND the refreshed roads — which carry its
 * audited answer — are on screen. Anything kept after that would be a second, worse opinion.
 */
export function dropTrip(store: CoverStore, tripId: string): boolean {
  store.touchedAt.delete(tripId);
  return store.byTrip.delete(tripId);
}

/* ── what to draw ───────────────────────────────────────────────────────────── */

export type CoverLines = {
  /** Links driven end to end — drawn from the link's own geometry, one id, no slicing. */
  fullIds: Set<string>;
  /** Part-driven links, as the driven sub-paths only. Blue stops where the driver stopped. */
  partials: [number, number][][];
};

/** The sub-path of a link between two arc positions. */
export function sliceLink(link: LinkRec, s: number, e: number): [number, number][] {
  const lo = Math.max(0, Math.min(s, e));
  const hi = Math.min(link.len, Math.max(s, e));
  if (!(hi > lo)) return [];
  const out: [number, number][] = [];
  const { coords, cum } = link;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = cum[i];
    const b = cum[i + 1];
    if (b <= lo || a >= hi) continue;
    const segLen = b - a;
    if (segLen <= 0) continue;
    const t0 = Math.max(0, (lo - a) / segLen);
    const t1 = Math.min(1, (hi - a) / segLen);
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const p0: [number, number] = [ax + (bx - ax) * t0, ay + (by - ay) * t0];
    const p1: [number, number] = [ax + (bx - ax) * t1, ay + (by - ay) * t1];
    const last = out[out.length - 1];
    if (!last || last[0] !== p0[0] || last[1] !== p0[1]) out.push(p0);
    out.push(p1);
  }
  return out.length >= 2 ? out : [];
}

/**
 * Collapse the per-trip stores into something drawable.
 *
 * The union across trips is taken here rather than at write time because a street can be driven
 * on Monday and again on Tuesday, and only the union is "how much of it has been done".
 */
export function coverLines(index: SnapIndex, store: CoverStore): CoverLines {
  const merged = new Map<string, number[]>();
  for (const perTrip of store.byTrip.values()) {
    for (const [linkId, list] of perTrip) {
      let into = merged.get(linkId);
      if (!into) { into = []; merged.set(linkId, into); }
      for (let i = 0; i < list.length; i += 2) addInterval(into, list[i], list[i + 1]);
    }
  }

  const byId = new Map<string, LinkRec>();
  for (const l of index.links) byId.set(l.id, l);

  const fullIds = new Set<string>();
  const partials: [number, number][][] = [];
  for (const [linkId, list] of merged) {
    const link = byId.get(linkId);
    if (!link) continue;
    if (intervalsLength(list) >= link.len * FULL_LINK_FRACTION) {
      fullIds.add(linkId);
      continue;
    }
    for (let i = 0; i < list.length; i += 2) {
      const piece = sliceLink(link, list[i], list[i + 1]);
      if (piece.length >= 2) partials.push(piece);
    }
  }
  return { fullIds, partials };
}

/** Metres of road this phone believes it has driven — the driver's own progress figure. */
export function coveredMeters(index: SnapIndex, store: CoverStore): number {
  const merged = new Map<string, number[]>();
  for (const perTrip of store.byTrip.values()) {
    for (const [linkId, list] of perTrip) {
      let into = merged.get(linkId);
      if (!into) { into = []; merged.set(linkId, into); }
      for (let i = 0; i < list.length; i += 2) addInterval(into, list[i], list[i + 1]);
    }
  }
  let total = 0;
  for (const list of merged.values()) total += intervalsLength(list);
  return total;
}

/* ── persistence shape (written by localSnapStore.ts) ───────────────────────── */

/**
 * On-disk shape. Each trip carries its own last-painted time, which is what expiry reads.
 * `owner` is the driver the guesses belong to: the file is per driver, and the owner is checked
 * on load as well, so a shared phone never shows one driver another's work.
 */
export type CoverSnapshot = {
  owner: string;
  ts: number;
  trips: [string, [string, number[]][], number][];
};

export function serialiseCover(owner: string, store: CoverStore): CoverSnapshot {
  const trips: [string, [string, number[]][], number][] = [];
  for (const [tripId, perTrip] of store.byTrip) {
    trips.push([tripId, [...perTrip], store.touchedAt.get(tripId) ?? Date.now()]);
  }
  return { owner, ts: Date.now(), trips };
}

/** Rebuilds a store, or an empty one when the snapshot is not this owner's or is malformed. */
export function deserialiseCover(snap: unknown, owner: string): CoverStore {
  const store = createCoverStore();
  const s = snap as CoverSnapshot | null;
  if (!s || s.owner !== owner || !Array.isArray(s.trips)) return store;
  for (const entry of s.trips) {
    if (!Array.isArray(entry) || entry.length !== 3) continue;
    const [tripId, pairs, touchedAt] = entry;
    if (typeof tripId !== 'string' || !Array.isArray(pairs)) continue;
    if (typeof touchedAt !== 'number' || !Number.isFinite(touchedAt)) continue;
    const perTrip = new Map<string, number[]>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [linkId, list] = pair;
      if (typeof linkId !== 'string' || !Array.isArray(list)) continue;
      if (list.length % 2 !== 0 || !list.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      perTrip.set(linkId, list.slice());
    }
    if (perTrip.size) {
      store.byTrip.set(tripId, perTrip);
      store.touchedAt.set(tripId, touchedAt);
    }
  }
  return store;
}
