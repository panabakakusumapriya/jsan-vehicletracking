const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const env = require('../config/env');
const { attributeTrip } = require('./globalUkm');
const { attributeTripLinks } = require('./linkCoverage');

/**
 * Parked-GPS jitter: the app keeps reporting while the vehicle sits still, so one parking spot
 * produces phantom "trips" of a few hundred metres of GPS drift. Left alone they inflate trip
 * counts, wreck averages (one teleported fix read as 107 km/h), and — the expensive part — CLAIM
 * COVERAGE for road nobody drove, so the next driver over that street is paid for coverage the
 * fleet already holds.
 *
 * The rule, calibrated against production data on 2026-09-29 (TESTTT 2026-09-28, verified
 * point-by-point, plus a 1012-trip fleet pass): a closed trip is parked noise iff its first and
 * last fix are within PARKED_JITTER_NET_MAX_METERS of each other AND no two of its fixes are
 * further apart than PARKED_JITTER_SPREAD_MAX_METERS. Both clauses are load-bearing — net alone
 * would delete a real out-and-back drive that returned near where it started (tiny net, huge
 * spread), spread alone would delete a genuine 169 m reposition inside a car park (net above the
 * limit, spread equal to it). Result: 14/14 parked sessions caught, 0/5 real trips of the same
 * driver-day excluded; fleet-wide it flags 15% of trips but 0.2% of the distance driven.
 *
 * The trade-off is stated plainly: a real drive that stays inside a 400 m circle AND returns to
 * within 150 m of where it began is geometrically indistinguishable from a parked session and is
 * excluded. The direction of the remaining error is deliberate — a jitter session that wanders
 * more than 400 m survives as a trip, because wrongly deleting real driving is worse than keeping
 * some noise.
 *
 * This module is the ONLY writer of the parkedJitter* fields. Everyone else reads the flag:
 * coverage engines refuse to treat a flagged trip as eligible (globalUkm.eligibility), reports
 * exclude it (trip.controller.buildTripFilter), and /parked deliberately does not, because a
 * jitter trip's last position is exactly where the vehicle really is.
 */

const EARTH_RADIUS_M = 6371008.8;

function haversine(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The measurements the verdict is built from. Points must be in recorded order (the caller's
 * query sorts by recordedAt). Non-finite fixes are dropped — an unparsed coordinate is not a
 * position and must not decide anything.
 */
function featuresFromPoints(rawPoints) {
  const points = (rawPoints || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const n = points.length;
  if (!n) return { n: 0, netMeters: null, spreadMeters: null, pathMeters: 0, spanSeconds: null };

  const first = points[0];
  const last = points[n - 1];
  const netMeters = n > 1 ? haversine(first, last) : 0;

  let pathMeters = 0;
  for (let i = 1; i < n; i += 1) pathMeters += haversine(points[i - 1], points[i]);

  // Widest pair. Chord distance on precomputed unit vectors: a few million multiply-adds for the
  // longest traces, where calling haversine per pair would allocate its way into the hundreds of
  // milliseconds. Chord is monotonic in great-circle distance, so the max-chord pair IS the
  // diameter; convert once at the end.
  const toRad = Math.PI / 180;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const lat = points[i].lat * toRad;
    const lon = points[i].lon * toRad;
    const cosLat = Math.cos(lat);
    x[i] = cosLat * Math.cos(lon);
    y[i] = cosLat * Math.sin(lon);
    z[i] = Math.sin(lat);
  }
  let chord2Max = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      const dz = z[i] - z[j];
      const chord2 = dx * dx + dy * dy + dz * dz;
      if (chord2 > chord2Max) chord2Max = chord2;
    }
  }
  const spreadMeters = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(chord2Max) / 2));

  const t0 = first.recordedAt ? new Date(first.recordedAt).getTime() : NaN;
  const t1 = last.recordedAt ? new Date(last.recordedAt).getTime() : NaN;
  const spanSeconds = Number.isFinite(t0) && Number.isFinite(t1) ? Math.round((t1 - t0) / 1000) : null;

  return { n, netMeters, spreadMeters, pathMeters, spanSeconds };
}

/** The one rule. See the header for why both clauses exist and how the thresholds were picked. */
function isParkedJitter(features) {
  if (!env.PARKED_JITTER_ENABLED) return false;
  if (!features || features.n < 2 || features.netMeters == null || features.spreadMeters == null) {
    return false;
  }
  return (
    features.netMeters <= env.PARKED_JITTER_NET_MAX_METERS &&
    features.spreadMeters <= env.PARKED_JITTER_SPREAD_MAX_METERS
  );
}

/**
 * The four fields Trip stores about a verdict, or null when there is nothing to decide — fewer
 * than two fixes means no displacement to measure, and "no verdict" must stay distinct from
 * "verdict: not jitter", which is why a null return must not be replaced with defaults.
 */
function verdictFields(features) {
  if (!features || features.n < 2) return null;
  return {
    parkedJitter: isParkedJitter(features),
    parkedJitterAt: new Date(),
    parkedJitterMeters: features.netMeters == null ? null : Math.round(features.netMeters),
    parkedJitterSpreadMeters:
      features.spreadMeters == null ? null : Math.round(features.spreadMeters),
  };
}

/**
 * Classify one trip and stamp the verdict. Points may be passed in when the caller already has
 * them (the matcher does); otherwise they are fetched.
 *
 * Fire-and-forget safe: never throws for a trip it cannot decide, and a failure releasing claims
 * is logged rather than propagated — this runs off a close path where nothing is waiting on it.
 */
async function classifyTrip(tripId, points) {
  if (!env.PARKED_JITTER_ENABLED) return null;

  const trip = await Trip.findById(tripId).select('status mapMatchStatus').lean();
  if (!trip) return null;
  // Closed rides only, for the reason globalUkm.attributeTrip gives: a claim decides who is paid
  // for a street and must not be made — or unmade — on a drive that is still changing.
  if (trip.status !== 'completed' && trip.status !== 'timed_out') return null;

  const pts =
    points ||
    (await LocationPoint.find({ tripId })
      .sort({ recordedAt: 1 })
      .select('lat lon recordedAt')
      .lean());
  const fields = verdictFields(featuresFromPoints(pts));
  if (!fields) return null;

  await Trip.updateOne({ _id: tripId }, { $set: fields });

  // The flag landed after the matcher had already snapped and attributed this trip: close-path
  // classification and the matcher race, and the matcher's version won. Both engines re-read the
  // trip, see the flag and release what it claimed — globalUkm recomputes to null figures and
  // drops its CoverageSegment rows, linkCoverage's attributeTripLinks releases its links and
  // clears the assigned figures. Attribution is idempotent, so a second visit is harmless.
  if (fields.parkedJitter && trip.mapMatchStatus === 'matched') {
    try {
      await attributeTrip(tripId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`trip-noise: global UKM release failed for trip ${tripId}:`, err.message);
    }
    try {
      await attributeTripLinks(tripId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`trip-noise: link coverage release failed for trip ${tripId}:`, err.message);
    }
  }

  return { tripId, ...fields };
}

module.exports = { featuresFromPoints, isParkedJitter, verdictFields, classifyTrip };
