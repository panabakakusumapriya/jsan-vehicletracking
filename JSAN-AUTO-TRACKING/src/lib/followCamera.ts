/**
 * FOLLOW MODE for the driver map: when the camera rides along with the vehicle, and when it lets go.
 *
 * Pure and synchronous — the screen feeds it GPS fixes and gestures and does what it answers — so
 * the rules can be driven through whole simulated drives in src/lib/__sim__/follow-camera.sim.mjs
 * instead of only on the road.
 *
 * The rules:
 *   - Following, every fix that actually moved pans the camera to it. Panning never changes zoom.
 *   - A real pan-away (the centre dragged ~80 m+) suspends it; a pinch does not.
 *   - While the vehicle is DRIVING, a suspension is temporary: once the map has gone untouched for
 *     FOLLOW_RESUME_MS the camera takes the vehicle back. Before this, following stayed off until
 *     the driver found the my-location button, so one brush of a thumb on a phone in a cradle — or
 *     opening the tab away from their area, which framed the area and switched following off —
 *     left the car driving off the edge of the map.
 *   - A PARKED vehicle never takes the camera back by itself: nobody is waiting for the map to
 *     catch up, and the driver may be studying the area on purpose.
 *   - "Driving" needs two moving fixes in a row, by Doppler speed OR by the position travelling
 *     further than its own error radius. Speed alone fails on handsets that report 0 km/h for every
 *     fix; position alone would let one bad fix count; and one fix alone would let a parked
 *     phone's jitter spike snap the camera away.
 */

export const MOVING_KMH = 7;
export const FOLLOW_RESUME_MS = 10_000;
/** How recent the last moving fix must be for the vehicle to still count as driving. */
const DRIVING_FRESH_MS = 15_000;
/** A centre this far from the followed position is a pan-away, not a pinch (~80 m). */
const PAN_AWAY_DEG = 8e-4;
/** Fixes closer than this to the last pan (~5 m) do not move the camera. */
const PAN_STEP_DEG = 5e-5;
const MIN_TRAVEL_M = 20;
const DEFAULT_ACCURACY_M = 15;
/** GPS heading is trusted from this speed up; below it the receiver's bearing wanders. */
const HEADING_MIN_KMH = 5;
/** With no usable heading, the course between two positions this far apart (or 1.5x the error). */
const COURSE_MIN_M = 12;
/** Direction changes smaller than this do not turn the camera — GPS heading wobbles a few degrees. */
const BEARING_STEP_DEG = 8;

export type LonLat = [number, number];

export interface FollowState {
  following: boolean;
  /** Where the camera was last sent while following; null = no followed position yet. */
  lastPan: LonLat | null;
  /** When the driver last touched the map. -Infinity = never, so a suspension by framing resumes
   *  at once — whatever the clock reads, not only once it is far from zero. */
  lastTouchAt: number;
  /** Consecutive moving fixes. */
  streak: number;
  prev: { lon: number; lat: number; at: number } | null;
  /** Direction of travel, degrees clockwise from north; null until the vehicle has shown one. */
  heading: number | null;
  /** Where the last computed course was measured from (no-heading handsets). */
  courseFrom: { lon: number; lat: number } | null;
  /** The bearing the camera was last turned to; changes under BEARING_STEP_DEG are ignored. */
  camBearing: number | null;
}

export interface Fix {
  lon: number;
  lat: number;
  speedKmh?: number | null;
  accuracy?: number | null;
  /** GPS bearing of travel, degrees from north; null when the receiver has none. */
  heading?: number | null;
}

export type FollowAction =
  | { kind: 'none' }
  /** Already following: move to the vehicle at the current zoom, facing `bearing` (null = as is). */
  | { kind: 'pan'; center: LonLat; bearing: number | null }
  /** Taking the vehicle back after a suspension: move there, lifting a zoomed-out view. */
  | { kind: 'resume'; center: LonLat; bearing: number | null };

export const createFollow = (): FollowState => ({
  following: true,
  lastPan: null,
  lastTouchAt: -Infinity,
  streak: 0,
  prev: null,
  heading: null,
  courseFrom: null,
  camBearing: null,
});

const norm = (deg: number) => ((deg % 360) + 360) % 360;
/** Smallest angle between two bearings, 0..180. */
export const bearingDelta = (a: number, b: number) => {
  const d = Math.abs(norm(a) - norm(b));
  return d > 180 ? 360 - d : d;
};

/**
 * Fold a new direction reading into the running one. Small differences are averaged (GPS heading
 * wobbles a few degrees either side of the road's true line, and following that wobble twitches the
 * map); a change of 30° or more is a real turn and is taken at once, so corners stay instant.
 */
function blendHeading(prev: number | null, next: number): number {
  if (prev === null) return norm(next);
  let d = norm(next) - prev;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return Math.abs(d) >= 30 ? norm(next) : norm(prev + d * 0.5);
}

/** Initial course from a to b, degrees clockwise from north. */
function courseBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dx = (b.lon - a.lon) * Math.cos((b.lat * Math.PI) / 180);
  const dy = b.lat - a.lat;
  return norm((Math.atan2(dx, dy) * 180) / Math.PI);
}

function metresBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dx = (b.lon - a.lon) * 111_320 * Math.cos((b.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110_574;
  return Math.hypot(dx, dy);
}

/** A GPS fix arrived. Mutates `s`; returns what the camera should do. */
export function onFix(s: FollowState, fix: Fix, now: number, placing: boolean): FollowAction {
  if (!Number.isFinite(fix.lon) || !Number.isFinite(fix.lat)) return { kind: 'none' };

  const kmh = typeof fix.speedKmh === 'number' && Number.isFinite(fix.speedKmh) ? fix.speedKmh : 0;
  let travelled = false;
  if (s.prev && now - s.prev.at <= DRIVING_FRESH_MS) {
    const acc = typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy) ? fix.accuracy : DEFAULT_ACCURACY_M;
    travelled = metresBetween(s.prev, fix) >= Math.max(MIN_TRAVEL_M, acc * 2);
  }
  s.prev = { lon: fix.lon, lat: fix.lat, at: now };
  s.streak = kmh >= MOVING_KMH || travelled ? s.streak + 1 : 0;
  trackHeading(s, fix, kmh);

  // Placement needs a still map; nothing moves the camera until the pin is dropped.
  if (placing) return { kind: 'none' };
  const center: LonLat = [fix.lon, fix.lat];

  if (!s.following) {
    if (s.streak >= 2 && now - s.lastTouchAt >= FOLLOW_RESUME_MS) {
      s.following = true;
      s.lastPan = center;
      return { kind: 'resume', center, bearing: turnCamera(s, true) };
    }
    return { kind: 'none' };
  }

  const lp = s.lastPan;
  const before = s.camBearing;
  const bearing = turnCamera(s, false);
  const turned = bearing !== null && bearing !== before;
  // A U-turn on the spot barely moves the vehicle — the turn alone is reason to move the camera.
  if (!turned && lp && Math.abs(lp[0] - fix.lon) <= PAN_STEP_DEG && Math.abs(lp[1] - fix.lat) <= PAN_STEP_DEG) {
    return { kind: 'none' };
  }
  s.lastPan = center;
  return { kind: 'pan', center, bearing };
}

/**
 * Keep the direction of travel up to date. GPS heading when the vehicle is genuinely driving (the
 * receiver's bearing is noise at a standstill); otherwise the course between positions far enough
 * apart to mean something — and only while moving, so a parked phone's slow drift never turns the
 * map. A stopped vehicle keeps the last heading it had, which is the way it is still facing.
 */
function trackHeading(s: FollowState, fix: Fix, kmh: number): void {
  const gps = typeof fix.heading === 'number' && Number.isFinite(fix.heading) ? fix.heading : null;
  if (gps !== null && kmh >= HEADING_MIN_KMH) {
    s.heading = blendHeading(s.heading, gps);
    s.courseFrom = { lon: fix.lon, lat: fix.lat };
    return;
  }
  if (!s.courseFrom) { s.courseFrom = { lon: fix.lon, lat: fix.lat }; return; }
  const acc = typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy) ? fix.accuracy : DEFAULT_ACCURACY_M;
  const moving = kmh >= HEADING_MIN_KMH || s.streak >= 1;
  if (!moving) return;
  if (metresBetween(s.courseFrom, fix) >= Math.max(COURSE_MIN_M, acc * 1.5)) {
    s.heading = blendHeading(s.heading, courseBetween(s.courseFrom, fix));
    s.courseFrom = { lon: fix.lon, lat: fix.lat };
  }
}

/** The bearing to send the camera to: the heading, unless it is within BEARING_STEP_DEG of where
 *  the camera already faces. `force` = always answer (resuming a camera that has been elsewhere). */
function turnCamera(s: FollowState, force: boolean): number | null {
  if (s.heading === null) return s.camBearing;
  if (force || s.camBearing === null || bearingDelta(s.heading, s.camBearing) >= BEARING_STEP_DEG) {
    s.camBearing = s.heading;
  }
  return s.camBearing;
}

/** The driver moved the map by hand (pan or pinch); `center` is where the camera settled. */
export function onGesture(s: FollowState, center: LonLat, now: number): void {
  // Every gesture restarts the resume clock, pinch included: a driver still handling the map is
  // not done looking at it.
  s.lastTouchAt = now;
  const p = s.lastPan;
  if (!p) return;
  if (Math.abs(p[0] - center[0]) > PAN_AWAY_DEG || Math.abs(p[1] - center[1]) > PAN_AWAY_DEG) {
    s.following = false;
  }
}

/** Is the vehicle driving right now, as far as the last fixes say? */
export function isDriving(s: FollowState, now: number): boolean {
  return s.streak >= 2 && Boolean(s.prev) && now - (s.prev?.at ?? 0) < DRIVING_FRESH_MS;
}

/** Follow from here — the my-location button, a dropped marker, or opening the tab mid-drive. */
export function startFollowing(s: FollowState, at: LonLat | null): void {
  s.following = true;
  s.lastPan = at;
}

/**
 * The camera was sent somewhere on purpose (the driver's area). Following is off, but this is not
 * a touch: the first moving fixes take the vehicle back straight away.
 */
export function suspendForFraming(s: FollowState): void {
  s.following = false;
  s.lastPan = null;
  s.lastTouchAt = -Infinity;
}
