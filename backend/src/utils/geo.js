/**
 * Plain geodesic helpers, in [lon, lat] order throughout — GeoJSON's order, so nothing has to be
 * flipped on its way into or out of Mongo. (Note this is the opposite of the {lat, lon} shape used
 * by LocationPoint and the tracking API; the boundary between the two conventions is deliberately
 * kept at the edge of this module.)
 */

const R = 6371008.8; // IUGG mean Earth radius, metres
const D = Math.PI / 180;

/**
 * Great-circle distance between two {lat, lon} points, in metres.
 *
 * The original inhabitant of this file, and the {lat, lon} half of the convention boundary noted
 * above: LocationPoint, the tracking API and the trip pipeline all speak {lat, lon}, so
 * valhalla.js and roadSegments.js call this rather than the [lon, lat] `haversine` below. Keeping
 * both is deliberate — the alternative is flipping coordinates at a dozen call sites, which is
 * exactly the kind of edit that silently swaps a latitude for a longitude somewhere.
 */
function haversineMeters(a, b) {
  if (!a || !b) return 0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance in metres between two [lon, lat] points. */
function haversine(a, b) {
  const dLat = (b[1] - a[1]) * D;
  const dLon = (b[0] - a[0]) * D;
  const la = a[1] * D;
  const lb = b[1] * D;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total length in metres of a [lon, lat][] line. */
function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

/** Initial bearing a -> b, degrees clockwise from north in [0, 360). */
function bearing(a, b) {
  const la = a[1] * D;
  const lb = b[1] * D;
  const dLon = (b[0] - a[0]) * D;
  const y = Math.sin(dLon) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLon);
  return ((Math.atan2(y, x) / D) + 360) % 360;
}

/**
 * Smallest angle between two bearings, 0..180.
 *
 * The attribution gate compares a trace's heading against a link's. Using the raw difference
 * would make 359 degrees and 1 degree look 358 apart instead of 2, which is exactly the case that
 * arises on a north-bound road.
 */
function bearingDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** [west, south, east, north] of a [lon, lat][] ring or line. */
function bboxOf(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Union of two bboxes; either may be null. */
function bboxUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Grow a bbox by `metres` on every side, converting to degrees at that latitude. */
function bboxPad(bbox, metres) {
  const [w, s, e, n] = bbox;
  const dLat = metres / 110574;
  const midLat = (s + n) / 2;
  const dLon = metres / (111320 * Math.max(0.01, Math.cos(midLat * D)));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
}

/** Ray casting against a single [lon, lat][] ring. */
function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Point in polygon, where `rings` is a GeoJSON Polygon's coordinates: ring 0 is the outer
 * boundary and any further rings are holes. Odd crossing count wins, which handles holes without
 * needing to know which ring is which.
 */
function pointInPolygon(pt, rings) {
  let crossings = 0;
  for (const ring of rings) if (pointInRing(pt, ring)) crossings++;
  return crossings % 2 === 1;
}

/**
 * The point half way along a line, measured by distance rather than by vertex count.
 *
 * Used to decide which work area a road link belongs to. A midpoint is the right probe for that:
 * an endpoint sits on an intersection and can fall either side of a boundary that runs down the
 * centre of the street, while the middle of a 94 m link is unambiguously inside one area.
 */
function midpointOf(coords) {
  if (!coords.length) return null;
  if (coords.length === 1) return coords[0];
  const half = lineLength(coords) / 2;
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversine(coords[i - 1], coords[i]);
    if (acc + seg >= half) {
      const t = seg === 0 ? 0 : (half - acc) / seg;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ];
    }
    acc += seg;
  }
  return coords[coords.length - 1];
}

/**
 * Ramer–Douglas–Peucker simplification of a [lon, lat][] line, with the tolerance in METRES.
 *
 * Degrees are scaled to metres locally (longitude by cos(latitude)) before measuring, so a
 * tolerance means the same thing in Melbourne as it would anywhere else — a tolerance expressed in
 * raw degrees silently gets stricter as you move away from the equator.
 *
 * This exists because the map has to send 402 work-area polygons to a browser and they carry
 * 263,795 vertices between them — around 6 MB of GeoJSON for outlines that are a few pixels wide
 * on screen. Simplification is for DISPLAY ONLY; the full geometry stays in Mongo, because
 * point-in-polygon assignment of road links must not be decided by a smoothed boundary.
 *
 * Iterative rather than recursive: a 6,451-vertex ring is enough to make a naive recursive
 * implementation a stack-depth risk.
 */
function simplifyPath(coords, toleranceMeters) {
  if (!Array.isArray(coords) || coords.length <= 2 || toleranceMeters <= 0) return coords;

  const mx = 111320 * Math.cos(coords[0][1] * D);
  const my = 110574;
  const tol2 = toleranceMeters * toleranceMeters;

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last - first < 2) continue;

    const ax = coords[first][0] * mx;
    const ay = coords[first][1] * my;
    const dx = coords[last][0] * mx - ax;
    const dy = coords[last][1] * my - ay;
    const len2 = dx * dx + dy * dy;

    let worst = 0;
    let worstAt = -1;
    for (let i = first + 1; i < last; i++) {
      const px = coords[i][0] * mx;
      const py = coords[i][1] * my;
      // Distance to the SEGMENT, not the infinite line: clamping t is what keeps a point beyond
      // an endpoint from being measured against a projection that is not on the segment at all.
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 > worst) {
        worst = d2;
        worstAt = i;
      }
    }

    if (worst > tol2 && worstAt > 0) {
      keep[worstAt] = 1;
      stack.push([first, worstAt], [worstAt, last]);
    }
  }

  const out = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i]);
  return out;
}

/**
 * Simplify a closed ring, keeping it closed and never letting it collapse below a triangle.
 *
 * A ring that simplifies to two points is not a polygon any more; GeoJSON needs four positions
 * with the first repeated at the end, and a 2dsphere index rejects anything less. When a ring is
 * too small to survive the tolerance, the original is returned rather than a broken one.
 */
function simplifyRing(ring, toleranceMeters) {
  if (!Array.isArray(ring) || ring.length <= 4) return ring;
  const simplified = simplifyPath(ring, toleranceMeters);
  if (simplified.length < 4) return ring;
  const first = simplified[0];
  const last = simplified[simplified.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) simplified.push([first[0], first[1]]);
  return simplified.length >= 4 ? simplified : ring;
}

/** Apply `simplifyRing` across a GeoJSON Polygon or MultiPolygon. */
function simplifyGeometry(geometry, toleranceMeters) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) => simplifyRing(ring, toleranceMeters)),
    };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) =>
        polygon.map((ring) => simplifyRing(ring, toleranceMeters))
      ),
    };
  }
  return geometry;
}

/**
 * A uniform grid over [lon, lat] space for "what is near this point" lookups.
 *
 * The attribution engine needs thousands of nearest-link probes per trip. Asking Mongo each time
 * would be thousands of round trips for one trip; this holds the candidate set for a single trip
 * in memory and answers each probe without leaving the process. Import uses the same structure to
 * assign 654k links to 402 polygons.
 */
class Grid {
  constructor(cellDegrees = 0.01) {
    this.cell = cellDegrees;
    this.cells = new Map();
  }

  static key(gx, gy) {
    return `${gx}:${gy}`;
  }

  /** Register `item` under every cell its bbox touches. */
  insert(bbox, item) {
    const [w, s, e, n] = bbox;
    const gx0 = Math.floor(w / this.cell);
    const gx1 = Math.floor(e / this.cell);
    const gy0 = Math.floor(s / this.cell);
    const gy1 = Math.floor(n / this.cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = Grid.key(gx, gy);
        let bucket = this.cells.get(k);
        if (!bucket) {
          bucket = [];
          this.cells.set(k, bucket);
        }
        bucket.push(item);
      }
    }
  }

  /** Everything registered in the cell containing `pt`, plus optionally the ring around it. */
  near(pt, ringRadius = 0) {
    const gx = Math.floor(pt[0] / this.cell);
    const gy = Math.floor(pt[1] / this.cell);
    if (ringRadius === 0) return this.cells.get(Grid.key(gx, gy)) || [];
    const out = [];
    const seen = new Set();
    for (let dx = -ringRadius; dx <= ringRadius; dx++) {
      for (let dy = -ringRadius; dy <= ringRadius; dy++) {
        const bucket = this.cells.get(Grid.key(gx + dx, gy + dy));
        if (!bucket) continue;
        for (const item of bucket) {
          if (seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  }
}

module.exports = {
  R,
  haversineMeters,
  haversine,
  lineLength,
  bearing,
  bearingDelta,
  bboxOf,
  bboxUnion,
  bboxPad,
  pointInRing,
  pointInPolygon,
  midpointOf,
  simplifyPath,
  simplifyRing,
  simplifyGeometry,
  Grid,
};
