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
 * session, at any gap over SESSION_GAP_MS, keyed `<clientTripId>~repair-<endedAt ms>`, then `#2`,
 * `#3`… Deliberately NOT the key live ingest uses for a continuation (`~<endedAt ms>`): a phone on
 * an old build still sending under the old id must get a fresh live trip from ingest, not have
 * today's driving appended to a closed trip this script made days earlier — and a re-run after
 * deploy must not pour old points into a live continuation. A trip whose whole late part is tiny
 * (usually just the phone's own end marker arriving after the close) is left alone rather than
 * turned into a 0 km trip.
 *
 * Only trips force-closed for length: closeReason 'overlong', or (closed before that field
 * existed) null without the 'superseded' signature — another of the driver's trips starting
 * within minutes of the close. A superseded trip with later points is a second phone on the same
 * account, which ingest deliberately leaves appending.
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
const { sumMeters } = require('../utils/rawDistance');
const { timezoneFromCoords } = require('../utils/tzFromCoords');
const { PIPELINE_RESET_SET, PIPELINE_RESET_UNSET } = require('../services/tripReset');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const ONLY = args.has('trip') ? String(args.get('trip')) : null;
const MIN_LATE_MS = 10 * 60 * 1000;
const SESSION_GAP_MS = 30 * 60 * 1000;
const MIN_LATE_POINTS = 20;
const SUPERSEDED_WINDOW_MS = 3 * 60 * 1000;
const MIN_LATE_METERS = 500;
const log = (...a) => console.log(...a);

/** Distance, count, ends and top speed of a point run — the way ingest accumulates them. */
function measure(points) {
  const meters = sumMeters(points);
  let maxSpeed = 0;
  for (const p of points) {
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

/**
 * Cut a time-ordered run into driving sessions at gaps over SESSION_GAP_MS. Never folded across a
 * gap, however small a session: that would stretch a trip over days and add the straight line
 * between the two places to its distance.
 */
function sessions(points) {
  const out = [];
  for (const p of points) {
    const cur = out[out.length - 1];
    if (cur && p.recordedAt - cur[cur.length - 1].recordedAt <= SESSION_GAP_MS) cur.push(p);
    else out.push([p]);
  }
  return out;
}

/** The shared pipeline reset, plus the matcher's own bookkeeping. */
const RESET_SET = {
  ...PIPELINE_RESET_SET,
  mapMatchError: null, mapMatchedAt: null, cleanedPointCount: null, ukmComputedAt: null,
  ukmBasis: null, assignedNetworkVersionId: null,
};
const RESET_UNSET = { ...PIPELINE_RESET_UNSET };

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../models/Trip');
  const User = require('../models/User');
  const LocationPoint = require('../models/LocationPoint');
  const CoverageSegment = require('../models/CoverageSegment');
  const LinkCoverage = require('../models/LinkCoverage');
  const { CONTINUE_AFTER_MS } = require('../controllers/tracking.controller');
  const repairKey = (clientTripId, endedAt) => `${clientTripId}~repair-${new Date(endedAt).getTime()}`;
  const maxMs = env.TRIP_MAX_DURATION_HOURS * 60 * 60 * 1000;

  const filter = ONLY
    ? { _id: new mongoose.Types.ObjectId(ONLY) }
    : {
      importBatchId: null, status: 'completed', closeReason: { $in: ['overlong', null] },
      endedAt: { $ne: null }, 'lastLocation.recordedAt': { $ne: null },
    };
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
    if (!ONLY) {
      const superseder = await Trip.exists({
        driverId: t.driverId, _id: { $ne: t._id }, clientTripId: { $not: /~/ },
        startedAt: { $gte: new Date(t.endedAt - SUPERSEDED_WINDOW_MS), $lte: new Date(t.endedAt.getTime() + SUPERSEDED_WINDOW_MS) },
      });
      if (superseder) { skipped++; continue; }
    }
    const cut = new Date(t.endedAt.getTime() + CONTINUE_AFTER_MS);
    const fields = '_id lat lon speedKmh heading accuracy recordedAt';
    const late = await LocationPoint.find({ tripId: t._id, recordedAt: { $gt: cut } }).sort({ recordedAt: 1 }).select(fields).lean();
    if (!late.length) continue;
    if (late.length < MIN_LATE_POINTS && measure(late).distanceMeters < MIN_LATE_METERS) {
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

    const baseKey = repairKey(t.clientTripId, t.endedAt);
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
  log(`\n${repaired} trips ${APPLY ? 'repaired' : 'to repair'} into ${newTrips} new trips (${movedTotal} points); ${skipped} left alone (a tiny tail, or closed by the driver's other phone).`);
  if (APPLY) log('All of them are pending: the map-match worker snaps them and works out UKM and coverage.');
  else log('Dry run — nothing written. Add --apply.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
