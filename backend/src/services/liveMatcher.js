const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const env = require('../config/env');
const valhalla = require('./valhalla');
const { attributeTripLinks } = require('./linkCoverage');
const { featuresFromPoints, verdictFields } = require('./tripNoise');
const { haversineMeters } = require('../utils/geo');

/**
 * Cleaned km and assigned UKM WHILE a trip runs.
 *
 * The map-matcher (services/mapMatcher.js) only takes a trip once it has closed, and crediting
 * roads (linkCoverage.attributeTripLinks) waits for the match — so for the whole of a drive, up to
 * eight hours, the panel had raw GPS km and nothing else: no cleaned distance, no assigned UKM, no
 * blue roads. Taking an hourly count meant waiting for the trip to end.
 *
 * Every LIVE_MATCH_EVERY_MINUTES (10) each running trip gets a pass:
 *   1. the GPS recorded since the last pass (from its last fix, so the pieces join) is snapped;
 *   2. the result is APPENDED to cleanedRouteShapes / cleanedDistanceMeters — never re-snapping
 *      the hours already done, so the load on the matcher grows with the new stretch only;
 *   3. the roads of the route so far are credited (attributeTripLinks with allowActive), which
 *      writes assigned UKM, in/out of area, and turns the roads blue on the phone and Coverage.
 *
 * mapMatchStatus stays 'pending' throughout: once the trip closes, the map-matcher re-snaps the
 * WHOLE trace in one go and re-credits it, replacing every provisional figure. A trip that then
 * turns out to be parked-GPS jitter or too short gives back whatever it was credited
 * (mapMatcher.discardLive).
 *
 * Writes are conditional on the pass they continue (`liveMatch.through` unchanged, trip still
 * active and unclaimed by the map-matcher), so two servers on one database, or a pass racing the
 * trip's close, can never append the same stretch twice or write over the final match.
 */

const PENDING = { $in: ['pending', null] };
let timer = null;
let running = false;

const lengthOf = (pts) => {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversineMeters(pts[i - 1], pts[i]);
  return m;
};

/**
 * One pass over one running trip. Returns what happened: 'matched' | 'waiting' | 'jitter' |
 * 'gone' | 'raced' | 'failed'. Never throws.
 */
async function livePass(tripId) {
  const trip = await Trip.findById(tripId)
    .select('status mapMatchStatus liveMatch cleanedDistanceMeters cleanedRouteShapes distanceMeters parkedJitter startMode clientTripId')
    .lean();
  if (!trip || trip.status !== 'active' || !['pending', null, undefined].includes(trip.mapMatchStatus)) return 'gone';
  const now = new Date();
  const prev = trip.liveMatch || null;
  const through = prev && prev.through ? new Date(prev.through) : null;
  const stillOurs = {
    _id: trip._id,
    status: 'active',
    mapMatchStatus: PENDING,
    ...(prev ? { 'liveMatch.through': prev.through } : { liveMatch: null }),
  };
  const stamp = (fields = {}) => Trip.updateOne(stillOurs, { $set: { liveMatch: { ...(prev || {}), ...fields, at: now } } });

  try {
    const pts = await LocationPoint.find({ tripId: trip._id, ...(through ? { recordedAt: { $gte: through } } : {}) })
      .sort({ recordedAt: 1 })
      .select('lat lon recordedAt accuracy -_id')
      .lean();

    // Not worth a call yet: try again next sweep after the interval.
    if (pts.length < 2 || lengthOf(pts) < env.LIVE_MATCH_MIN_SEGMENT_METERS) {
      await stamp({ through: prev ? prev.through : null });
      return 'waiting';
    }

    // Parked-GPS jitter: a phone reporting from a car park must not credit the street beside it.
    // Asked of the whole trip so far while it is short — past a few km it is plainly a drive.
    if (!(prev && prev.passes) && (trip.distanceMeters || 0) < 5000) {
      const verdict = verdictFields(featuresFromPoints(pts), trip);
      if (verdict && verdict.parkedJitter) {
        await stamp({ through: prev ? prev.through : null });
        return 'jitter';
      }
    }

    const r = await valhalla.matchTrace(pts, {
      gapFill: env.GAP_FILL_ENABLED,
      gapFillMinMs: env.GAP_FILL_MIN_SECONDS * 1000,
    });
    const matchedMeters = (prev ? prev.matchedMeters : 0) + (r.matchedMeters || 0);
    const totalMeters = (prev ? prev.totalMeters : 0) + (r.totalMeters || 0);
    const res = await Trip.updateOne(stillOurs, {
      $set: {
        cleanedDistanceMeters: (prev ? trip.cleanedDistanceMeters || 0 : 0) + (r.distanceMeters || 0),
        cleanedRouteShapes: [...(prev ? trip.cleanedRouteShapes || [] : []), ...(r.shapes || [])],
        cleanedMatchedRatio: totalMeters > 0 ? matchedMeters / totalMeters : null,
        liveMatch: {
          at: now,
          through: pts[pts.length - 1].recordedAt,
          passes: (prev ? prev.passes : 0) + 1,
          points: (prev ? prev.points : 0) + pts.length - (through ? 1 : 0),
          matchedMeters,
          totalMeters,
        },
      },
    });
    // Another pass, or the trip's close, got there first: nothing written, nothing to credit.
    if (!res.modifiedCount) return 'raced';

    if (env.LINK_COVERAGE_ENABLED) {
      try {
        await attributeTripLinks(trip._id, { allowActive: true });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`live-matcher: crediting roads failed for trip ${trip._id}:`, err.message);
      }
    }
    return 'matched';
  } catch (err) {
    // A matcher outage must not stop the sweep, nor be retried every minute: wait the interval.
    await stamp({ through: prev ? prev.through : null }).catch(() => {});
    // eslint-disable-next-line no-console
    console.error(`live-matcher: trip ${trip._id}:`, err.message);
    return 'failed';
  }
}

/** One sweep: running trips whose last pass is at least the interval old (or never), oldest first. */
async function tick() {
  if (!env.LIVE_MATCH_ENABLED) return {};
  const due = new Date(Date.now() - env.LIVE_MATCH_EVERY_MINUTES * 60 * 1000);
  const trips = await Trip.find({
    status: 'active',
    mapMatchStatus: PENDING,
    parkedJitter: { $ne: true },
    // The first figures ten minutes into a drive, not on its first fix.
    startedAt: { $lte: due },
    $or: [{ liveMatch: null }, { 'liveMatch.at': { $lte: due } }],
  })
    .select('_id')
    .sort({ 'liveMatch.at': 1, startedAt: 1 })
    .limit(env.LIVE_MATCH_MAX_PER_TICK)
    .lean();
  const counts = {};
  for (const t of trips) {
    // eslint-disable-next-line no-await-in-loop
    const result = await livePass(t._id);
    counts[result] = (counts[result] || 0) + 1;
  }
  return counts;
}

function startLiveMatcher() {
  if (timer || !env.VALHALLA_ENABLED || !env.LIVE_MATCH_ENABLED) return null;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const counts = await tick();
      if (counts.matched || counts.failed) {
        // eslint-disable-next-line no-console
        console.log(`live-matcher: ${counts.matched || 0} trips updated, ${counts.failed || 0} failed`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('live-matcher tick failed:', err.message);
    } finally {
      running = false;
    }
  }, 60 * 1000);
  // eslint-disable-next-line no-console
  console.log(`   Live matcher: running trips every ${env.LIVE_MATCH_EVERY_MINUTES} min`);
  return timer;
}

function stopLiveMatcher() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startLiveMatcher, stopLiveMatcher, tick, livePass };
