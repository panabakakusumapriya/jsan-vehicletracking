/**
 * "Is this driver in their area?" — for the live map, against the 25 m-simplified outlines the
 * server sends (GET /api/tracking/live-areas).
 *
 * Mirrors backend/src/services/assignedAreas.js makeAreaTester: point in polygon first (holes
 * respected), then a boundary distance for the points that failed it, so a vehicle driving the
 * street that IS the boundary is not called outside. The server says how close counts
 * (`edgeMeters`), because it knows both its own buffer and how much the outline was smoothed.
 */

export type Outline =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

const D = Math.PI / 180;

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Metres from [lon, lat] to the nearest point of a ring, on a local flat projection. */
function distanceToRing(lon: number, lat: number, ring: number[][]): number {
  const mx = 111320 * Math.cos(lat * D);
  const my = 110574;
  const px = lon * mx;
  const py = lat * my;
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const ax = ring[i - 1][0] * mx;
    const ay = ring[i - 1][1] * my;
    const dx = ring[i][0] * mx - ax;
    const dy = ring[i][1] * my - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    best = Math.min(best, ex * ex + ey * ey);
  }
  return Math.sqrt(best);
}

const polygonsOf = (o: Outline): number[][][][] => (o.type === 'Polygon' ? [o.coordinates] : o.coordinates);

/** Inside the outline, or within `edgeMeters` of its boundary. */
export function isInside(lon: number, lat: number, outline: Outline, edgeMeters: number): boolean {
  const polygons = polygonsOf(outline);
  for (const rings of polygons) {
    let crossings = 0;
    for (const ring of rings) if (inRing(lon, lat, ring)) crossings++;
    if (crossings % 2 === 1) return true;
  }
  if (edgeMeters <= 0) return false;
  for (const rings of polygons) {
    for (const ring of rings) if (distanceToRing(lon, lat, ring) <= edgeMeters) return true;
  }
  return false;
}
