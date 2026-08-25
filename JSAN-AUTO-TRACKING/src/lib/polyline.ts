/**
 * Valhalla polyline decoding for the driver app.
 *
 * Kept byte-for-byte behaviour-identical to admin-panel/src/lib/polyline.ts on purpose: the phone
 * and the portal draw the same snapped geometry, and a divergence here would show up as two
 * different "cleaned" routes for one trip with nothing in the API to blame.
 */

/**
 * Decodes a Valhalla-encoded polyline (Google's polyline algorithm at precision 6 — i.e. 1e6
 * scale — rather than the more common precision 5) into [lon, lat] pairs, matching the
 * [lon, lat] convention every map layer in this codebase uses.
 *
 * The precision is the whole point: Valhalla emits 6, the Google default is 5. Decoding a
 * precision-6 string at precision 5 does not fail, it silently yields coordinates ten times too
 * large — a trip in Hyderabad lands somewhere off Antarctica, which reads like a GPS bug rather
 * than a decoder bug and is a long way to chase.
 */
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const precision = 1e-6;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lon * precision, lat * precision]);
  }
  return coords;
}

/**
 * Decode a trip's chunked Valhalla shapes (Trip.cleanedRouteShapes — one string per matched
 * chunk, see backend services/valhalla.js) into a single flat path.
 *
 * Prefer decodeRouteShapeLines for anything drawn on a map: flattening welds the end of one
 * matched chunk to the start of the next, and where the matcher dropped an unmatchable stretch
 * that weld is a straight line through buildings that was never driven.
 */
export function decodeRouteShapes(shapes: string[] | null | undefined): [number, number][] {
  if (!shapes || !shapes.length) return [];
  return shapes.flatMap((s) => decodePolyline6(s));
}

/**
 * Decode a trip's chunked shapes into one path per chunk, so a renderer can draw them as separate
 * lines and leave the gaps between chunks empty — which is what the gaps actually mean.
 */
export function decodeRouteShapeLines(shapes: string[] | null | undefined): [number, number][][] {
  if (!shapes || !shapes.length) return [];
  return shapes.map((s) => decodePolyline6(s)).filter((line) => line.length > 1);
}
