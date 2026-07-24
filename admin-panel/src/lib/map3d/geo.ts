/** Linear interpolation between two lat/lon points by fraction t (0..1). */
export function lerpLatLon(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  t: number
): [number, number] {
  return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
}

/** Interpolates a compass heading (degrees) along its shortest angular path, so 350deg -> 10deg turns through 0 instead of the long way round. */
export function lerpHeadingDeg(a: number, b: number, t: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return (a + diff * t + 360) % 360;
}

/** Great-circle distance in meters -- accurate enough at city-block scale. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * True compass bearing from (lat1,lon1) to (lat2,lon2), or null if the two
 * points are too close together (under 3m) to give a meaningful direction --
 * e.g. while genuinely stopped, where GPS jitter alone could otherwise
 * produce a random-looking bearing between two near-identical points.
 */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  if (distanceMeters(lat1, lon1, lat2, lon2) < 3) return null;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
