const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const env = require('../config/env');
const { matchTrace } = require('./valhalla');
const { recomputeDriverUkm } = require('./roadSegments');
const { attributeTrip, computeTripMetrics } = require('./globalUkm');

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
    // UKM depends on the snapped geometry that was just written, so this is the earliest point it
    // can be computed. The driver's whole timeline is recomputed rather than just this trip: UKM is
    // relative to earlier trips, and a trip arriving out of order (an offline sync landing days
    // later) changes which trip owns a road. See roadSegments.js.
    // Deliberately not fatal — a failure here must not undo a good match.
    try {
      await recomputeDriverUkm(trip.driverId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`map-matcher: UKM recompute failed for driver ${trip.driverId}:`, err.message);
    }

    // Global UKM. Deliberately a SECOND call rather than a replacement for the one above: the
    // per-driver figure answers "am I repeating myself" and every existing report reads it, while
    // this one answers "did the fleet already drive this" and is the number the customer is
    // billed on. They are different questions with different right answers.
    //
    // Note what this fixes about the line above it. recomputeDriverUkm walks ONE driver's history,
    // so a trip syncing days late could only ever change its own driver's numbers — a road it
    // really drove first while another driver was credited for it stayed miscredited forever.
    // attributeTrip settles that across the whole coverage scope and recomputes whoever lost the
    // road, regardless of which driver or project they belong to.
    try {
      await attributeTrip(trip._id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`map-matcher: global UKM attribution failed for trip ${trip._id}:`, err.message);
    }

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
  // Catch-up sweep: recompute UKM for drivers holding a trip that HAS snapped geometry but no UKM
  // figure. processTrip() computes UKM inline, but that only covers trips matched through this
  // worker — a trip matched by the re-match script, or matched before the UKM feature existed,
  // ends up with a route and no figure, and the trip page then hides the UKM card entirely. That
  // is how 49 trips ended up looking like UKM was broken when it had simply never been asked.
  // Making the worker notice and fix it removes the standing dependency on remembering to run
  // backfill:ukm after anything touches geometry.
  try {
    const stale = await Trip.distinct('driverId', {
      status: { $in: ['completed', 'timed_out'] },
      mapMatchStatus: 'matched',
      cleanedRouteShapes: { $exists: true, $ne: [] },
      $or: [
        // Never computed.
        { ukmMeters: null },
        { ukmComputedAt: null },
        // Computed, but from geometry that has since been replaced. Re-matching a trip rewrites
        // its route; the UKM figure derived from the OLD route then describes roads the trip no
        // longer claims to have driven. A trip re-matched from 23 km to 130 km kept a UKM figure
        // built from the 23 km version until this clause was added.
        { $expr: { $lt: ['$ukmComputedAt', '$mapMatchedAt'] } },
      ],
    });
    // Bounded per tick: this is pure local CPU, but a large backlog should not monopolise a tick.
    for (const driverId of stale.slice(0, env.MAP_MATCH_MAX_PER_TICK)) {
      await recomputeDriverUkm(driverId);
      counts.ukmRecomputed = (counts.ukmRecomputed || 0) + 1;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('map-matcher: UKM catch-up sweep failed:', err.message);
  }

  // The same catch-up, for the global figures. A trip matched by the re-match script, or matched
  // before this feature existed, has snapped geometry and no coverage claim — and an unclaimed
  // road is worse than a missing number, because the NEXT driver over that street is then paid for
  // coverage the fleet already has. Bounded per tick like the sweep above.
  if (env.GLOBAL_UKM_ENABLED) {
    try {
      const unattributed = await Trip.find({
        status: { $in: ['completed', 'timed_out'] },
        mapMatchStatus: 'matched',
        cleanedRouteShapes: { $exists: true, $ne: [] },
        $or: [
          { globalUkmComputedAt: null },
          // Computed from geometry that has since been replaced by a re-match.
          { $expr: { $lt: ['$globalUkmComputedAt', '$mapMatchedAt'] } },
          // Computed by an older build of the engine.
          { ukmAlgorithmVersion: { $ne: env.UKM_ALGORITHM_VERSION } },
        ],
      })
        .select('_id')
        // Oldest first, so coverage is claimed in roughly the order it was driven and the
        // takeover path stays the exception rather than the rule.
        .sort({ startedAt: 1 })
        .limit(env.MAP_MATCH_MAX_PER_TICK);

      for (const { _id } of unattributed) {
        await attributeTrip(_id);
        counts.globalUkmAttributed = (counts.globalUkmAttributed || 0) + 1;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('map-matcher: global UKM catch-up sweep failed:', err.message);
    }
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
