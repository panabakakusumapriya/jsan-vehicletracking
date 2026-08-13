const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const env = require('../config/env');
const { matchTrace } = require('./valhalla');

/**
 * Background worker: snaps each completed trip's raw GPS trace onto the road network via
 * Valhalla, producing a "cleaned" distance/route layer alongside the raw one.
 *
 * Why a background job and not part of ingest: map-matching needs the trip's FULL point
 * sequence (Valhalla's HMM matcher reasons over the whole trace, not one fix at a time), and
 * this runs against a shared free community server — it has no business sitting in the hot
 * 10s heartbeat path. Trips become eligible the moment they leave `active` status, however
 * that happened (device end-signal in tracking.controller.js, or the watchdog's
 * closeDeadTrips) — this worker doesn't care which; it just polls for the result.
 *
 * Claiming mirrors driverWatchdog.js: a conditional update off `mapMatchStatus: 'pending'`
 * means a restart, or a second server instance, can never process the same trip twice.
 *
 * PENDING_FILTER matches 'pending' OR the field being entirely absent. Every trip that existed
 * before this feature shipped has no mapMatchStatus in its *stored* document at all — Mongoose
 * only shows 'pending' for them in memory (the schema default applied on hydration), which a
 * raw query for the literal string 'pending' never sees. Without the `null` branch here (Mongo
 * equality-vs-null matches "missing" too) this worker would silently never touch a single
 * pre-existing trip.
 */
const PENDING_FILTER = { $in: ['pending', null] };

let timer = null;
let running = false;

/** One trip: claim it, fetch its raw points, match, persist. Never throws. */
async function processTrip(tripId) {
  const trip = await Trip.findOneAndUpdate(
    { _id: tripId, mapMatchStatus: PENDING_FILTER },
    { $set: { mapMatchStatus: 'matching' } },
    { new: true }
  );
  if (!trip) return null; // someone else claimed it, or it moved on already

  try {
    if ((trip.distanceMeters || 0) < env.MAP_MATCH_MIN_DISTANCE_METERS) {
      await Trip.updateOne({ _id: trip._id }, { $set: { mapMatchStatus: 'skipped' } });
      return 'skipped';
    }

    const points = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon recordedAt');

    if (points.length < 2) {
      await Trip.updateOne({ _id: trip._id }, { $set: { mapMatchStatus: 'skipped' } });
      return 'skipped';
    }

    const { distanceMeters, shapes, matchedMeters, totalMeters } = await matchTrace(points, {
      gapFill: env.GAP_FILL_ENABLED,
      gapFillMinMs: env.GAP_FILL_MIN_SECONDS * 1000,
    });
    await Trip.updateOne(
      { _id: trip._id },
      {
        $set: {
          cleanedDistanceMeters: distanceMeters,
          cleanedRouteShapes: shapes,
          // How much of the trace was genuinely snapped rather than kept as raw GPS geometry.
          // See matchSegment() in services/valhalla.js for when the fallback kicks in.
          cleanedMatchedRatio: totalMeters > 0 ? matchedMeters / totalMeters : null,
          mapMatchStatus: 'matched',
          mapMatchedAt: new Date(),
          mapMatchError: null,
        },
      }
    );
    return 'matched';
  } catch (err) {
    await Trip.updateOne(
      { _id: trip._id },
      { $set: { mapMatchStatus: 'failed', mapMatchError: err.message.slice(0, 500) } }
    );
    return 'failed';
  }
}

/** One full sweep. Exported so tests can drive it without waiting on the timer. */
async function tick() {
  const candidates = await Trip.find({
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: PENDING_FILTER,
  })
    .select('_id')
    .limit(env.MAP_MATCH_MAX_PER_TICK);

  const counts = { matched: 0, skipped: 0, failed: 0 };
  // Sequential, not parallel — this is a shared free community server, not our own.
  for (const { _id } of candidates) {
    const outcome = await processTrip(_id);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}

function startMapMatcher() {
  if (timer || !env.VALHALLA_ENABLED) return null;
  const everyMs = Math.max(5, env.MAP_MATCH_INTERVAL_SECONDS) * 1000;

  timer = setInterval(async () => {
    if (running) return; // a slow sweep must not stack on itself
    running = true;
    try {
      const { matched, skipped, failed } = await tick();
      if (matched || skipped || failed) {
        // eslint-disable-next-line no-console
        console.log(`map-matcher: ${matched} matched, ${skipped} skipped, ${failed} failed`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('map-matcher tick failed:', err.message);
    } finally {
      running = false;
    }
  }, everyMs);

  // eslint-disable-next-line no-console
  console.log(`   Map-matcher every ${everyMs / 1000}s against ${env.VALHALLA_URL}`);
  return timer;
}

function stopMapMatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startMapMatcher, stopMapMatcher, tick, processTrip };
