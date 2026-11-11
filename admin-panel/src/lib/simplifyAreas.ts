/**
 * Work-area outlines with less detail, for when the map is zoomed out.
 *
 * The outlines arrive simplified to 25 m, which is right at street level and far too much from
 * further away: framing a whole project puts every vertex of 3,900 polygons on screen at once,
 * most of them a fraction of a pixel apart, and that alone held the map to 40 frames a second.
 * Each zoom band gets its own copy, simplified to about a pixel at that band's closest zoom
 * (Douglas–Peucker), so what is drawn looks the same and costs a fraction.
 */

type Ring = number[][];
interface Feature { geometry: { type: string; coordinates: unknown } }
interface Collection { features: Feature[] }

const RAD = Math.PI / 180;

function simplifyRing(ring: Ring, tol: number): Ring | null {
  const n = ring.length - 1; // the last point repeats the first
  if (n < 3) return null;
  if (n <= 4) return ring;
  const kx = Math.cos(ring[0][1] * RAD);
  const tol2 = tol * tol;
  // A ring has no ends: split it at the vertex farthest from the first.
  let far = 1;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const dx = (ring[i][0] - ring[0][0]) * kx;
    const dy = ring[i][1] - ring[0][1];
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = 1;
  keep[far] = 1;
  keep[n] = 1;
  const stack = [0, far, far, n];
  let widest = 0;
  let widestAt = -1;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = ring[a][0] * kx;
    const ay = ring[a][1];
    const ex = ring[b][0] * kx - ax;
    const ey = ring[b][1] - ay;
    const len2 = ex * ex + ey * ey || 1e-30;
    let max = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = ring[i][0] * kx - ax;
      const py = ring[i][1] - ay;
      const cross = px * ey - py * ex;
      const d = (cross * cross) / len2;
      if (d > max) { max = d; at = i; }
    }
    if (max > widest) { widest = max; widestAt = at; }
    if (at >= 0 && max > tol2) {
      keep[at] = 1;
      stack.push(a, at, at, b);
    }
  }
  const out: Ring = [];
  for (let i = 0; i <= n; i++) if (keep[i]) out.push(ring[i]);
  if (out.length >= 4) return out;
  // Smaller than the tolerance all round: keep it as a triangle, so the area is still on the map.
  if (widestAt < 0) return null;
  const [p, q] = widestAt < far ? [widestAt, far] : [far, widestAt];
  return [ring[0], ring[p], ring[q], ring[0]];
}

function simplifyPolygon(rings: Ring[], tol: number): Ring[] | null {
  const outer = simplifyRing(rings[0], tol);
  if (!outer) return null;
  const out = [outer];
  // A hole that collapses is simply gone at this scale.
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i].length > 5 ? simplifyRing(rings[i], tol) : null;
    if (hole && hole.length > 4) out.push(hole);
  }
  return out;
}

/** The same features — same properties objects — with outlines simplified to `tol` degrees. */
export function simplifyAreas<T extends Collection>(fc: T, tol: number): T {
  const features = fc.features.map((f): Feature => {
    const g = f.geometry;
    if (g.type === 'Polygon') {
      const rings = simplifyPolygon(g.coordinates as Ring[], tol);
      return rings ? { ...f, geometry: { type: 'Polygon', coordinates: rings } } : f;
    }
    if (g.type === 'MultiPolygon') {
      const polys = (g.coordinates as Ring[][]).map((p) => simplifyPolygon(p, tol)).filter(Boolean);
      return polys.length ? { ...f, geometry: { type: 'MultiPolygon', coordinates: polys } } : f;
    }
    return f;
  });
  return { ...fc, features } as T;
}

/** Zoom bands and the tolerance (degrees) each is drawn at; the last band is the outlines as sent. */
export const AREA_LOD_ZOOMS = [5.5, 8.5, 11, 13];
export const AREA_LOD_TOLERANCES = [0.02, 0.003, 0.0005, 0.0001];
export const areaLodOf = (zoom: number) => {
  let i = 0;
  while (i < AREA_LOD_ZOOMS.length && zoom >= AREA_LOD_ZOOMS[i]) i += 1;
  return i;
};
