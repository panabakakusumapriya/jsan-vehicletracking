import type { MyArea } from './api';

/**
 * Which of the driver's allocated areas is "the one they are working" — the area the map opens on
 * and the Navigate button heads for.
 *
 *   1. The area the driver is standing in. Several (overlapping or nested outlines): the smallest.
 *   2. Otherwise the nearest one, measured to its bounding box.
 *   3. No position at all: the most recently assigned, which is the one the office just handed out.
 *
 * Pure and synchronous so it can run on every GPS fix: a driver holds tens of areas, not thousands.
 */

export type Bbox = [number, number, number, number];

export interface ActiveArea {
  area: MyArea;
  bbox: Bbox;
  /** The driver is inside this area right now. */
  inside: boolean;
}

type Ring = number[][];

function outlineRings(area: MyArea): Ring[][] {
  const g = area.outline;
  if (!g || !g.coordinates) return [];
  return g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
}

export function areaBbox(area: MyArea): Bbox | null {
  if (area.bbox && area.bbox.length === 4 && area.bbox.every(Number.isFinite)) return area.bbox;
  let b: Bbox | null = null;
  for (const polygon of outlineRings(area)) {
    for (const [lon, lat] of polygon[0] ?? []) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      b = b
        ? [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)]
        : [lon, lat, lon, lat];
    }
  }
  return b;
}

/** Ray casting. Holes count: a point in a courtyard hole is outside the area. */
function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function containsPoint(area: MyArea, bbox: Bbox, p: [number, number]): boolean {
  if (p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3]) return false;
  const polygons = outlineRings(area);
  // No outline shipped (areas imported before outlines were stored): the box is all there is.
  if (!polygons.length) return true;
  return polygons.some((rings) => rings.length > 0 && inRing(p, rings[0]) && !rings.slice(1).some((h) => inRing(p, h)));
}

/** Squared distance from p to the box, in degrees with longitude scaled for latitude. */
function boxDistance2(p: [number, number], [w, s, e, n]: Bbox): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const dx = (p[0] < w ? w - p[0] : p[0] > e ? p[0] - e : 0) * k;
  const dy = p[1] < s ? s - p[1] : p[1] > n ? p[1] - n : 0;
  return dx * dx + dy * dy;
}

const boxSize = ([w, s, e, n]: Bbox) => (e - w) * (n - s);

export function pickActiveArea(areas: readonly MyArea[], pos: [number, number] | null): ActiveArea | null {
  const boxed: { area: MyArea; bbox: Bbox }[] = [];
  for (const area of areas) {
    const bbox = areaBbox(area);
    if (bbox) boxed.push({ area, bbox });
  }
  if (!boxed.length) return null;

  const hasPos = pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1]);
  if (hasPos) {
    const containing = boxed.filter((b) => containsPoint(b.area, b.bbox, pos));
    if (containing.length) {
      containing.sort((a, b) => boxSize(a.bbox) - boxSize(b.bbox));
      return { ...containing[0], inside: true };
    }
    let best = boxed[0];
    let bestD = boxDistance2(pos, best.bbox);
    for (const b of boxed) {
      const d = boxDistance2(pos, b.bbox);
      if (d < bestD) { best = b; bestD = d; }
    }
    return { ...best, inside: false };
  }

  const stamp = (a: MyArea) => (a.assignedAt ? Date.parse(a.assignedAt) || 0 : 0);
  let newest = boxed[0];
  for (const b of boxed) if (stamp(b.area) > stamp(newest.area)) newest = b;
  return { ...newest, inside: false };
}
