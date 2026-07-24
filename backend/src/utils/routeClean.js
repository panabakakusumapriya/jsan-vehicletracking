const { haversineMeters } = require('./geo');

/**
 * Remove outlier points and near-duplicate stationary heartbeats from a
 * time-sorted array of route points. Returns a clean array suitable for
 * polyline rendering with no invalid lines or gaps.
 *
 * Rules (modelled after MyCarTracks route cleanup):
 *  1. Deduplicate: skip points < 5 m from the previous kept point.
 *  2. Spike rejection: skip a point if the implied speed from the previous
 *     kept point exceeds 250 km/h (GPS multipath / reflection spike).
 *  3. Gap markers: when consecutive points are > 2 min apart AND > 500 m
 *     apart, insert a null separator so renderers can break the polyline.
 */
function cleanRoutePoints(rawPoints) {
  if (!rawPoints || rawPoints.length < 2) return rawPoints;

  const MAX_SPEED_KMH = 250;
  const MIN_DIST_M = 5;
  const GAP_TIME_MS = 2 * 60 * 1000;
  const GAP_DIST_M = 500;

  const out = [rawPoints[0]];
  let prev = rawPoints[0];

  for (let i = 1; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    const dist = haversineMeters(prev, { lat: p.lat, lon: p.lon });
    const dtMs = new Date(p.recordedAt) - new Date(prev.recordedAt);
    const dtSec = dtMs / 1000;

    // Skip near-duplicates (stationary heartbeats from older data)
    if (dist < MIN_DIST_M) continue;

    // Spike rejection: implied speed > 250 km/h is physically impossible
    if (dtSec > 0 && (dist / dtSec) * 3.6 > MAX_SPEED_KMH) continue;

    // Gap detection: insert null separator for polyline break
    if (dtMs > GAP_TIME_MS && dist > GAP_DIST_M) {
      out.push(null);
    }

    out.push(p);
    prev = p;
  }

  return out;
}

module.exports = { cleanRoutePoints };
