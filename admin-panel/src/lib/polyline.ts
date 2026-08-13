/**
 * Decodes a Valhalla-encoded polyline (Google's polyline algorithm at precision 6 — i.e. 1e6
 * scale — rather than the more common precision 5) into [lon, lat] pairs, matching the
 * [lon, lat] convention the rest of this app's map layers use (see TripPathLayer.ts).
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
 * Decode and concatenate a trip's chunked Valhalla shapes (Trip.cleanedRouteShapes — one
 * string per matched chunk, see backend services/valhalla.js) into a single path.
 */
export function decodeRouteShapes(shapes: string[] | null | undefined): [number, number][] {
  if (!shapes || !shapes.length) return [];
  return shapes.flatMap((s) => decodePolyline6(s));
}
