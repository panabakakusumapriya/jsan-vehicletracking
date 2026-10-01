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
}

export interface Fix {
  lon: number;
  lat: number;
  speedKmh?: number | null;
  accuracy?: number | null;
}

export type FollowAction =
  | { kind: 'none' }
  /** Already following: move to the vehicle at the current zoom. */
  | { kind: 'pan'; center: LonLat }
  /** Taking the vehicle back after a suspension: move there, lifting a zoomed-out view. */
  | { kind: 'resume'; center: LonLat };

export const createFollow = (): FollowState => ({
  following: true,
  lastPan: null,
  lastTouchAt: -Infinity,
  streak: 0,
  prev: null,
});

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

  // Placement needs a still map; nothing moves the camera until the pin is dropped.
  if (placing) return { kind: 'none' };
  const center: LonLat = [fix.lon, fix.lat];

  if (!s.following) {
    if (s.streak >= 2 && now - s.lastTouchAt >= FOLLOW_RESUME_MS) {
      s.following = true;
      s.lastPan = center;
      return { kind: 'resume', center };
    }
    return { kind: 'none' };
  }

  const lp = s.lastPan;
  if (lp && Math.abs(lp[0] - fix.lon) <= PAN_STEP_DEG && Math.abs(lp[1] - fix.lat) <= PAN_STEP_DEG) {
    return { kind: 'none' };
  }
  s.lastPan = center;
  return { kind: 'pan', center };
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
