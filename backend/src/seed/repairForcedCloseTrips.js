/**
 * Split trips that kept receiving points after the server force-closed them.
 *
 * Until the ingest fix (tracking.controller.js, splitAfterForcedClose), a trip force-closed for
 * running past TRIP_MAX_DURATION_HOURS kept every point the phone went on sending under its id —
 * typically the next day's driving, after a sign-out left the trip open and the next sign-in
 * resumed it. Those points sat in a trip dated the day before: missing from their own day, never
 * road-matched, no UKM, no coverage.
 *
 * For each such trip this moves every point recorded after the close (plus the same 2-minute grace
 * the ingest fix uses) into new trips, re-measures everything, releases the closed trip's road
 * claims and sends them all back to the map-matcher. The worker then snaps them and works out UKM
 * and coverage like any trip: the closed trip re-claims what it really drove, the new trips claim
 * the rest.
 *
 * Some phones kept one trip id for days, so the late points are cut into one trip per driving
 * session, at any gap over SESSION_GAP_MS. The first takes the key ingest would now use
 * (`<clientTripId>~<endedAt ms>`), the rest `#2`, `#3`… A session under MIN_SESSION_POINTS joins
 * the one before it; a trip whose whole late part is that small (usually just the phone's own
 * end marker arriving after the close) is left alone rather than turned into a 0 km trip.
 *
 * Safety
 *   - DRY RUN unless --apply. Writes nothing without it.
 *   - Idempotent: a repaired trip no longer has points after its close, so it is not picked again.
 *   - Raw GPS is never deleted or altered — only which trip a point belongs to.
 *
 * Usage
 *   node src/seed/repairForcedCloseTrips.js            # dry run
 *   node src/seed/repairForcedCloseTrips.js --apply
 *   node src/seed/repairForcedCloseTrips.js --trip=<id> --apply
 */
const { connectDB } = require('../config/db');
const env = require('../config/env');
const { haversineMeters } = require('../utils/geo');
const { timezoneFromCoords } = require('../utils/tzFromCoords');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const ONLY = args.has('trip') ? String(args.get('trip')) : null;
const GRACE_MS = 2 * 60 * 1000; // = CONTINUE_AFTER_MS in tracking.controller.js
const MIN_LATE_MS = 10 * 60 * 1000;
const SESSION_GAP_MS = 30 * 60 * 1000;
const MIN_SESSION_POINTS = 20;
const MIN_LATE_METERS = 500;
const log = (...a) => console.log(...a);

/** Distance, count, ends and top speed of a point run — the way ingest accumulates them. */
function measure(points) {
  let meters = 0;
  let maxSpeed = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const d = haversineMeters(points[i - 1], p);
      if (d >= 5) meters += d;
    }
    if (p.speedKmh > maxSpeed && p.speedKmh <= 250) maxSpeed = p.speedKmh;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return {
    distanceMeters: meters,
    pointCount: points.length,
    maxSpeedKmh: maxSpeed,
    startedAt: first.recordedAt,
    endedAt: last.recordedAt,
    startLocation: { lat: first.lat, lon: first.lon },
    endLocation: { lat: last.lat, lon: last.lon },
    lastLocation: { lat: last.lat, lon: last.lon, speed: last.speedKmh || 0, heading: last.heading ?? null, recordedAt: last.recordedAt },
  };
}

/** Cut a time-ordered run at gaps over SESSION_GAP_MS; fold too-small sessions into a neighbour. */
function sessions(points) {
  const out = [];
  for (const p of points) {
    const cur = out[out.length - 1];
    if (cur && p.recordedAt - cur[cur.length - 1].recordedAt <= SESSION_GAP_MS) cur.push(p);
    else out.push([p]);
  }
  const merged = [];
  for (const s of out) {
    if (merged.length && s.length < MIN_SESSION_POINTS) merged[merged.length - 1].push(...s);
    else merged.push(s);
  }
  if (merged.length > 1 && merged[0].length < MIN_SESSION_POINTS) merged[1].unshift(...merged.shift());
  return merged;
}

/** Everything the pipeline derives, back to "not worked out yet". */
const RESET_SET = {
  mapMatchStatus: 'pending', mapMatchError: null, mapMatchedAt: null, cleanedDistanceMeters: null,
  cleanedMatchedRatio: null, cleanedPointCount: null, ukmMeters: null, ukmWithinTripMeters: null,
  ukmComputedAt: null, ukmStatus: 'pending', distinctRoadMeters: null, sameTripRepeatMeters: null,
  historicalDuplicateMeters: null, globalUniqueMeters: null, unmatchedReviewMeters: null,
  globalUkmComputedAt: null, linkCoverageStatus: 'pending', linkCoverageComputedAt: null,
  inAreaMeters: null, outAreaMeters: null, linkUkmMeters: null, linkUkmNetworkMeters: null,
  linkCoveredCount: null, effectiveUkmMeters: null, ukmBasis: null, assignedNetworkVersionId: null,
  parkedJitter: false, parkedJitterAt: null, parkedJitterMeters: null, parkedJitterSpreadMeters: null,
};
const RESET_UNSET = {
  cleanedRouteShapes: 1, ukmNewShapes: 1, ukmUniqueShapes: 1, ukmDuplicateShapes: 1, outAreaShapes: 1, linkUkmShapes: 1,
};

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../models/Trip');
  const User = require('../models/User');
  const LocationPoint = require('../models/LocationPoint');
  const CoverageSegment = require('../models/CoverageSegment');
  const LinkCoverage = require('../models/LinkCoverage');
  const { continuationKey } = require('../controllers/tracking.controller');
  const maxMs = env.TRIP_MAX_DURATION_HOURS * 60 * 60 * 1000;

  const filter = ONLY
    ? { _id: new mongoose.Types.ObjectId(ONLY) }
    : { importBatchId: null, status: 'completed', endedAt: { $ne: null }, 'lastLocation.recordedAt': { $ne: null } };
  const trips = (await Trip.find(filter)
    .select('clientTripId driverId managerId vehicleId projectId coverageScopeId coverageCycleId startedAt endedAt lastLocation timezone')
    .sort({ startedAt: 1 })
    .lean())
    .filter((t) => ONLY || (
      t.lastLocation.recordedAt - t.endedAt > MIN_LATE_MS &&
      t.endedAt - t.startedAt >= maxMs
    ));
  const names = new Map((await User.find({ _id: { $in: trips.map((t) => t.driverId) } }).select('name').lean())
    .map((u) => [String(u._id), u.name]));

  log(`${trips.length} force-closed trips with points after their close${APPLY ? '' : ' (dry run)'}\n`);
  let movedTotal = 0;
  let newTrips = 0;
  let repaired = 0;
  let skipped = 0;
  for (const t of trips) {
    const cut = new Date(t.endedAt.getTime() + GRACE_MS);
    const fields = '_id lat lon speedKmh heading recordedAt';
    const late = await LocationPoint.find({ tripId: t._id, recordedAt: { $gt: cut } }).sort({ recordedAt: 1 }).select(fields).lean();
    if (!late.length) continue;
    if (late.length < MIN_SESSION_POINTS && measure(late).distanceMeters < MIN_LATE_METERS) {
      skipped++;
      continue;
    }
    const kept = await LocationPoint.find({ tripId: t._id, recordedAt: { $lte: cut } }).sort({ recordedAt: 1 }).select(fields).lean();
    const zone = t.timezone || 'UTC';
    const day = (d) => d.toLocaleString('en-AU', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' });
    const parts = sessions(late);
    log(`${names.get(String(t.driverId)) || t.driverId} · trip ${t._id}`);
    log(`   closed ${day(t.endedAt)} after ${((t.endedAt - t.startedAt) / 3600000).toFixed(1)} h; keeps ${kept.length} points`);
    for (const part of parts) {
      const m = measure(part);
      log(`   → new trip ${day(m.startedAt)} – ${day(m.endedAt)}: ${part.length} points, ${(m.distanceMeters / 1000).toFixed(1)} km`);
    }
    movedTotal += late.length;
    newTrips += parts.length;
    repaired++;
    if (!APPLY) continue;

    const baseKey = continuationKey(t.clientTripId, t.endedAt);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const key = i === 0 ? baseKey : `${baseKey}#${i + 1}`;
      const pm = measure(part);
      let cont = await Trip.findOne({ clientTripId: key, driverId: t.driverId });
      if (!cont) {
        cont = await Trip.create({
          clientTripId: key,
          driverId: t.driverId,
          managerId: t.managerId || null,
          vehicleId: t.vehicleId || null,
          projectId: t.projectId || null,
          coverageScopeId: t.coverageScopeId || null,
          coverageCycleId: t.coverageCycleId || null,
          status: 'completed',
          startedAt: pm.startedAt,
          endedAt: pm.endedAt,
          timezone: timezoneFromCoords(pm.startLocation.lat, pm.startLocation.lon) || t.timezone || null,
        });
      }
      await LocationPoint.updateMany({ _id: { $in: part.map((p) => p._id) } }, { $set: { tripId: cont._id } });
      const all = await LocationPoint.find({ tripId: cont._id }).sort({ recordedAt: 1 }).select(fields).lean();
      await Trip.updateOne({ _id: cont._id }, { $set: { ...measure(all), ...RESET_SET }, $unset: RESET_UNSET });
    }

    // The closed trip: re-measured on what it really holds, its claims released (they may rest on
    // geometry that included the late points), and sent back to the matcher.
    await CoverageSegment.deleteMany({ firstTripId: t._id });
    await LinkCoverage.deleteMany({ firstTripId: t._id });
    const km = kept.length ? measure(kept) : null;
    await Trip.updateOne({ _id: t._id }, {
      $set: {
        ...RESET_SET,
        closeReason: 'overlong',
        ...(km ? {
          distanceMeters: km.distanceMeters, pointCount: km.pointCount, maxSpeedKmh: km.maxSpeedKmh,
          endLocation: km.endLocation, lastLocation: km.lastLocation,
        } : { distanceMeters: 0, pointCount: 0 }),
      },
      $unset: RESET_UNSET,
    });
  }
  log(`\n${repaired} trips ${APPLY ? 'repaired' : 'to repair'} into ${newTrips} new trips (${movedTotal} points); ${skipped} left alone (only a tiny tail after the close).`);
  if (APPLY) log('All of them are pending: the map-match worker snaps them and works out UKM and coverage.');
  else log('Dry run — nothing written. Add --apply.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
