const Trip = require('../models/Trip');
const { haversineMeters } = require('../utils/geo');
const { encodePolyline6 } = require('./valhalla');

/**
 * UKM (unique kilometers) per trip: how much of a trip ran on road the driver had not covered on
 * any EARLIER trip. Drive a route Monday and it counts; drive the same route Tuesday and Tuesday's
 * trip earns nothing. Roads repeated inside a single trip count once too.
 *
 * Distinct from the fleet /ukm tab, which answers a different question (unique road per driver
 * across all time, from its own UkmEdge collection) and is left untouched by this module.
 *
 * Why this is derived from the snapped route and not the raw GPS trace
 * -------------------------------------------------------------------
 * Identifying "the same road twice" needs a stable identity for a piece of road. Raw fixes cannot
 * give one: the existing /ukm tab buckets raw lat/lon into ~11 m grid cells, and this fleet's GPS
 * error is around 15 m — larger than the cell. So the same street driven twice lands in different
 * cells and gets counted as two different roads. Snapped geometry follows road centrelines, so a
 * second pass over the same road returns the same vertices, and the comparison actually holds.
 *
 * Why the whole driver is recomputed instead of updated incrementally
 * ------------------------------------------------------------------
 * "New" depends on what came before, so the answer depends on ordering. Attributing roads in the
 * order trips happen to be PROCESSED would let an offline trip that syncs days late steal credit
 * from the trip that really drove the road first, and re-running would silently change history.
 * Ordering by startedAt and recomputing the driver's whole timeline makes the result deterministic
 * and idempotent: same data in, same numbers out, no matter when or how often this runs. A driver
 * holds tens of trips, so the recompute is milliseconds of CPU and no extra storage — there is no
 * segment collection to keep in sync, which is also why this cannot drift out of agreement with
 * the trips it describes.
 */

// ~1.1 m. Snapped vertices come back at 1e-6 precision and are identical between traversals of the
// same road, so this only needs to absorb float jitter — not GPS error, which is already gone.
const KEY_PRECISION = 1e5;

/** Decode a Valhalla precision-6 polyline into {lat, lon} vertices. */
function decodePolyline6(encoded) {
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
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
    out.push({ lat: lat * 1e-6, lon: lon * 1e-6 });
  }
  return out;
}

const cell = (v) => Math.round(v * KEY_PRECISION);

/**
 * Key for one piece of road, independent of travel direction: the two endpoints sorted, so
 * driving A->B and later B->A yields the same key and the road is not counted twice.
 */
function segmentKey(a, b) {
  const p = `${cell(a.lat)},${cell(a.lon)}`;
  const q = `${cell(b.lat)},${cell(b.lon)}`;
  return p < q ? `${p}|${q}` : `${q}|${p}`;
}

/**
 * Distinct road pieces in one trip's snapped route, already deduplicated against itself — so a
 * road driven three times in one trip appears once. Returns Map(key -> metres).
 */
function segmentsForTrip(cleanedRouteShapes) {
  return analyseTrip(cleanedRouteShapes, new Set()).withinTrip;
}

/**
 * Walk a trip's snapped route once and work out three things together:
 *   withinTrip - Map(key -> metres) of the distinct road it covered, deduped against itself
 *   newKeys    - the subset never seen before (`seen` holds everything earlier trips covered)
 *   newShapes  - those new stretches as encoded polylines, in the order they were driven
 *
 * newShapes exists so the map can be coloured from the SAME pass that produces the number. The
 * fleet /ukm page learned this the hard way: it computes its figures in the backend but re-derives
 * the green "unique" overlay separately in the browser, from different input, so the line and the
 * total cannot be reconciled. Deciding once, here, makes them agree by construction.
 *
 * A stretch breaks whenever a segment is not new, and at each shape boundary, so contiguous runs
 * stay contiguous and a repeated middle section splits the highlight in two — which is exactly
 * what a reader needs to see.
 */
function analyseTrip(cleanedRouteShapes, seen) {
  const withinTrip = new Map();
  const newKeys = new Set();
  const runs = [];
  let current = null;

  const flush = () => {
    if (current && current.length > 1) runs.push(current);
    current = null;
  };

  if (!cleanedRouteShapes || !cleanedRouteShapes.length) {
    return { withinTrip, newKeys, newShapes: [] };
  }

  for (const shape of cleanedRouteShapes) {
    let vertices;
    try {
      vertices = decodePolyline6(shape);
    } catch {
      continue; // a shape we cannot read contributes nothing rather than breaking the trip
    }
    flush(); // never join a run across two separately-matched shapes

    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1];
      const b = vertices[i];
      const metres = haversineMeters(a, b);
      // Zero-length steps appear where two shapes are stitched at the same coordinate.
      if (metres <= 0) continue;

      const key = segmentKey(a, b);
      if (!withinTrip.has(key)) withinTrip.set(key, metres);

      // New means: no earlier trip covered it, and this trip has not already claimed it.
      if (!seen.has(key) && !newKeys.has(key)) {
        newKeys.add(key);
        if (current) current.push(b);
        else current = [a, b];
      } else {
        flush();
      }
    }
    flush();
  }

  return { withinTrip, newKeys, newShapes: runs.map(encodePolyline6) };
}

/** Sum of a Map(key -> metres). */
const sumMetres = (map) => {
  let total = 0;
  for (const m of map.values()) total += m;
  return total;
};

/**
 * Recompute every trip's UKM for one driver, oldest trip first.
 *
 * Writes two numbers per trip, which answer different questions and are both useful:
 *   ukmMeters           - road not covered by any EARLIER trip (the cross-day figure)
 *   ukmWithinTripMeters - UKM of the trip against itself only, ignoring history
 * A trip that merely repeated old ground gets ukmMeters 0 but keeps a meaningful
 * ukmWithinTripMeters, so the trip page never has to show a bare zero with no explanation.
 *
 * Only matched trips carry snapped geometry, so unmatched ones are left null rather than
 * being recorded as zero UKM — absent and none are not the same claim.
 */
async function recomputeDriverUkm(driverId) {
  const trips = await Trip.find({
    driverId,
    status: { $in: ['completed', 'timed_out'] },
  })
    .select('_id startedAt cleanedRouteShapes')
    .sort({ startedAt: 1, _id: 1 }) // _id breaks ties so the order is total, not just partial
    .lean();

  const seen = new Set();
  const now = new Date();
  const ops = [];

  for (const trip of trips) {
    if (!trip.cleanedRouteShapes || !trip.cleanedRouteShapes.length) continue;

    const { withinTrip, newKeys, newShapes } = analyseTrip(trip.cleanedRouteShapes, seen);

    let newMetres = 0;
    for (const key of newKeys) newMetres += withinTrip.get(key) || 0;
    // Everything this trip covered is now "seen", not just what was new to it — otherwise a road
    // already driven by an earlier trip would become claimable again by a later one.
    for (const key of withinTrip.keys()) seen.add(key);

    ops.push({
      updateOne: {
        filter: { _id: trip._id },
        update: {
          $set: {
            ukmMeters: newMetres,
            ukmWithinTripMeters: sumMetres(withinTrip),
            ukmNewShapes: newShapes,
            ukmComputedAt: now,
          },
          // Earlier builds of this feature wrote these names; drop them so a handover reader does
          // not find two figures for the same thing and have to guess which one is live.
          $unset: { uniqueRoadMeters: 1, selfUniqueRoadMeters: 1, uniqueRoadComputedAt: 1 },
        },
      },
    });
  }

  if (!ops.length) return 0;

  // One unordered bulkWrite instead of an update per trip. This runs inline after every successful
  // map-match, so the round trips were on the hot path: a driver with 40 trips meant 40 sequential
  // writes each time any one of their trips was matched. Unordered because the updates are
  // independent — one failing must not silently skip the rest.
  const res = await Trip.bulkWrite(ops, { ordered: false });
  return res.modifiedCount ?? ops.length;
}

module.exports = {
  recomputeDriverUkm,
  segmentsForTrip,
  segmentKey,
  decodePolyline6,
};
