const Trip = require('../models/Trip');
const User = require('../models/User');
const LocationPoint = require('../models/LocationPoint');
const RejectedPoint = require('../models/RejectedPoint');
const NetworkVersion = require('../models/NetworkVersion');
const AreaAssignment = require('../models/AreaAssignment');
const WorkArea = require('../models/WorkArea');
const asyncHandler = require('../utils/asyncHandler');
const { haversineMeters } = require('../utils/geo');
const { timezoneFromCoords } = require('../utils/tzFromCoords');
const { accessibleDriverFilter } = require('../utils/scope');
const { emitLocation } = require('../realtime/io');
const env = require('../config/env');
const { closeDeadTrips, driversWithLiveApp } = require('../services/tripLifecycle');
// Legacy per-driver UKM edges. Still written on trip completion (see below) so the old figures
// stay available for side-by-side comparison against the global engine during cutover, but
// nothing reads them for a business number any more — see services/globalUkm.js.
const { computeTripUkm } = require('../services/ukmCompute');
const { getDriverRoads } = require('../services/driverRoads');
const { scopeForProject } = require('../services/coverageScope');
const { rebuildScope } = require('../services/globalUkm');
const mongoose = require('mongoose');
const zlib = require('zlib');
const { promisify } = require('util');

/**
 * POST /api/tracking/ingest   (driver only)
 *
 * ONE endpoint for both paths:
 *   - Online heartbeat  -> body.points has ~1 element (sent every 10s).
 *   - Offline sync       -> body.points has many (flushed from device SQLite on reconnect).
 *
 * Every point is idempotent:
 *   - clientTripId groups points into a server Trip (upserted once).
 *   - clientId dedupes points (unique index) so retries never double-insert.
 *
 * Body: { points: [{
 *   clientId, clientTripId, lat, lon, speedKmh, heading, accuracy, altitude,
 *   batteryLevel, isMoving, recordedAt (ISO), tripStatus?('active'|'ended'|'timed_out')
 * }] }
 *
 * Returns { accepted, acceptedClientIds, rejected, rejectedClientIds } — the device deletes
 * every acked row. Rejected ids are acked TOO (so the queue drains) but were not stored.
 */
exports.ingest = asyncHandler(async (req, res) => {
  const driver = req.user;
  const points = Array.isArray(req.body?.points) ? req.body.points : [];
  if (!points.length) return res.status(400).json({ error: 'points array is required' });
  if (points.length > 5000) return res.status(413).json({ error: 'too many points in one batch (max 5000)' });

  // Group by client trip id.
  const groups = new Map();
  for (const p of points) {
    const key = p.clientTripId || `adhoc:${driver._id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const acceptedClientIds = [];
  // Points that could not become LocationPoints. They are PRESERVED in RejectedPoint (raw, exactly
  // as sent) and only then acked — so the device's queue drains without the observation being
  // thrown away. See models/RejectedPoint.js.
  const rejectedClientIds = [];
  const toPreserve = [];
  const liveUpdates = [];

  for (const [clientTripId, pts] of groups) {
    pts.sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    const first = pts[0];

    // Upsert the trip for this clientTripId.
    let trip = await Trip.findOne({ clientTripId, driverId: driver._id });
    if (!trip) {
      // Enforce single active session: close any lingering active trips for this driver
      await Trip.updateMany(
        { driverId: driver._id, status: 'active' },
        { $set: { status: 'completed', endedAt: new Date() } }
      );
      trip = await Trip.create({
        clientTripId,
        driverId: driver._id,
        managerId: driver.managerId || null,
        vehicleId: driver.vehicleId || null,
        // Stamped at start, like timezone below and for the same reason: a trip is fixed history.
        // Moving a driver onto another project next month must not retroactively re-attribute
        // last month's coverage to a customer who never received it.
        //
        // projectIds is an array — a driver can hold several at once. Taking the first is only
        // unambiguous when they hold exactly one, so anything else is left null rather than
        // guessed, and surfaces as unattributed on the coverage page where a human can see it.
        projectId: driver.projectIds && driver.projectIds.length === 1 ? driver.projectIds[0] : null,
        // Stamped here for exactly the same reason projectId above is: the coverage scope decides
        // which history this trip's roads are deduplicated against, and moving a project into a
        // different scope next year must not silently re-price roads already invoiced. Resolved
        // from the project, falling back to the fleet-wide default scope — see
        // services/coverageScope.js for why one shared default is the correct starting position.
        ...(await scopeForProject(
          driver.projectIds && driver.projectIds.length === 1 ? driver.projectIds[0] : null
        )),
        status: 'active',
        startedAt: new Date(first.recordedAt),
        startLocation: { lat: first.lat, lon: first.lon },
        // Derived from where the trip actually STARTED, not from the driver's profile. A trip
        // is a fixed piece of history: reassigning the driver's zone later must not silently
        // reinterpret last month's start and end times.
        timezone: timezoneFromCoords(first.lat, first.lon) || driver.timezone || null,
      });
    }

    // The trip exists but the watchdog closed it while the device was silent, and now points are
    // arriving for it again — so the session never actually ended. Without reviving it here the
    // points still get appended (the append path below does not care about status), but the trip
    // stays closed, /api/tracking/live only returns active trips, and the driver is invisible on
    // the map while their data flows in. Measured before this fix: 98 of the newest 400 closed
    // trips were still collecting points, 245,330 points in total, some arriving 96 hours after
    // the trip had been closed.
    //
    // Only 'timed_out' is revived. 'completed' means the device itself said the trip ended, and a
    // late offline batch for such a trip must not reopen it.
    //
    // The freshness check keeps an offline sync of genuinely old data from resurrecting history:
    // only points recent enough that the session could still be running count as "still driving".
    if (trip.status === 'timed_out') {
      const newestMs = new Date(pts[pts.length - 1].recordedAt).getTime();
      const stillLive = Number.isFinite(newestMs)
        && Date.now() - newestMs < env.SESSION_DEAD_AFTER_SECONDS * 1000;
      if (stillLive) {
        await Trip.updateOne(
          { _id: trip._id, status: 'timed_out' },
          {
            $set: {
              status: 'active',
              endedAt: null,
              // The trip is about to grow, so any snapped route already computed for it describes
              // only part of the drive. Send it back through matching once it finally closes,
              // rather than leaving a cleaned layer and a UKM figure frozen mid-trip.
              mapMatchStatus: 'pending',
              cleanedDistanceMeters: null,
              cleanedMatchedRatio: null,
              ukmMeters: null,
              ukmWithinTripMeters: null,
              // Same reasoning for the global figures: the trip is about to grow, so anything
              // derived from its current geometry describes only part of the drive. Back to
              // 'pending' — not 0, which would claim the trip covered no new road.
              ukmStatus: 'pending',
              distinctRoadMeters: null,
              sameTripRepeatMeters: null,
              historicalDuplicateMeters: null,
              globalUniqueMeters: null,
              unmatchedReviewMeters: null,
              globalUkmComputedAt: null,
            },
            $unset: {
              cleanedRouteShapes: 1,
              ukmNewShapes: 1,
              endLocation: 1,
              ukmUniqueShapes: 1,
              ukmDuplicateShapes: 1,
            },
          }
        );
        trip.status = 'active';
        trip.endedAt = null;
      }
    }

    let last = trip.lastLocation && trip.lastLocation.lat != null ? trip.lastLocation : null;
    let addedDistance = 0;
    let addedCount = 0;
    let maxSpeed = trip.maxSpeedKmh || 0;

    for (const p of pts) {
      const recordedAt = new Date(p.recordedAt);
      const doc = {
        clientId: p.clientId || null,
        tripId: trip._id,
        driverId: driver._id,
        vehicleId: driver.vehicleId || null,
        lat: p.lat,
        lon: p.lon,
        speedKmh: Number(p.speedKmh) || 0,
        heading: p.heading ?? null,
        accuracy: p.accuracy ?? null,
        altitude: p.altitude ?? null,
        batteryLevel: p.batteryLevel ?? null,
        isMoving: p.isMoving ?? true,
        recordedAt,
      };

      // Reject unusable points BEFORE hitting Mongo, and ack them anyway — see the catch below
      // for why refusing to ack is the expensive option.
      const badPoint =
        !Number.isFinite(p.lat) || !Number.isFinite(p.lon) ||
        p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180
          ? 'coordinates out of range'
          : Number.isNaN(recordedAt.getTime())
            ? 'unparseable recordedAt'
            : null;

      if (badPoint) {
        toPreserve.push({
          driverId: driver._id,
          clientId: p.clientId || null,
          clientTripId: p.clientTripId || null,
          reason: badPoint,
          raw: p,
        });
        if (p.clientId) {
          acceptedClientIds.push(p.clientId);
          rejectedClientIds.push({ clientId: p.clientId, reason: badPoint });
        }
        continue;
      }

      try {
        await LocationPoint.create(doc);
      } catch (e) {
        if (e.code === 11000) {
          // Already ingested (duplicate clientId) — safe to ack so device can delete it.
          if (p.clientId) acceptedClientIds.push(p.clientId);
          continue;
        }

        /**
         * One bad point must never fail the whole batch.
         *
         * This used to `throw`, which 500s the entire request — so NOTHING is acked, the device
         * deletes nothing, and on its next trigger it re-sends the identical oldest 200 points.
         * Because the device uploads on every GPS fix (~3 s) and retries 3x per attempt, a single
         * permanently-unstorable row becomes an infinite re-upload loop: ~50 KB re-sent every few
         * seconds, forever. That is how a driver's phone reached 25 GB in a month, and why the
         * radio never idled long enough to cool down.
         *
         * So: ack it, so the device drops it and the queue drains past it. Report it separately
         * so a point we could not store is visible rather than silently discarded.
         */
        toPreserve.push({
          driverId: driver._id,
          clientId: p.clientId || null,
          clientTripId: p.clientTripId || null,
          reason: e.message,
          raw: p,
        });
        if (p.clientId) {
          acceptedClientIds.push(p.clientId);
          rejectedClientIds.push({ clientId: p.clientId, reason: e.message });
        }
        continue;
      }

      if (p.clientId) acceptedClientIds.push(p.clientId);
      if (last) {
        const segDist = haversineMeters(last, { lat: p.lat, lon: p.lon });
        // Only accumulate distance for real movement (> 5 m)
        if (segDist >= 5) addedDistance += segDist;
      }
      if (doc.speedKmh > maxSpeed) maxSpeed = doc.speedKmh;
      addedCount += 1;
      last = { lat: p.lat, lon: p.lon, speed: doc.speedKmh, heading: doc.heading, recordedAt };
    }

    // Did the device signal the trip ended (speed hit 0) or timed out (20-min no-move)?
    const endSignal = [...pts].reverse().find(
      (p) => p.tripStatus === 'ended' || p.tripStatus === 'timed_out'
    );

    const update = { $inc: {}, $set: {} };
    if (addedDistance) update.$inc.distanceMeters = addedDistance;
    if (addedCount) update.$inc.pointCount = addedCount;
    if (maxSpeed > (trip.maxSpeedKmh || 0)) update.$set.maxSpeedKmh = maxSpeed;
    if (last) update.$set.lastLocation = last;
    if (endSignal && trip.status === 'active') {
      update.$set.status = endSignal.tripStatus === 'timed_out' ? 'timed_out' : 'completed';
      update.$set.endedAt = new Date(endSignal.recordedAt);
      update.$set.endLocation = { lat: endSignal.lat, lon: endSignal.lon };
    }
    if (!Object.keys(update.$inc).length) delete update.$inc;
    if (!Object.keys(update.$set).length) delete update.$set;
    if (Object.keys(update).length) await Trip.updateOne({ _id: trip._id }, update);

    if (last) liveUpdates.push({ trip, last, ended: !!endSignal });

    // Fire-and-forget UKM computation when a trip just completed.
    if (endSignal && trip.status === 'active') {
      computeTripUkm(trip._id, driver._id).catch(() => {});
    }
  }

  // Keep the driver's own zone current from their newest position, so a driver who crosses a
  // border is right on the panel before their next trip begins. The lookup is in-process and
  // costs nothing; the write only happens on an actual change, which is rare.
  const newest = liveUpdates.length ? liveUpdates[liveUpdates.length - 1].last : null;
  if (newest) {
    const zone = timezoneFromCoords(newest.lat, newest.lon);
    if (zone && zone !== driver.timezone) {
      driver.timezone = zone;
      await User.updateOne({ _id: driver._id }, { $set: { timezone: zone } });
    }
  }

  // Push the freshest position per trip to live watchers (admins + owning manager).
  for (const u of liveUpdates) {
    emitLocation({
      driverId: driver._id.toString(),
      driverName: driver.name,
      managerId: driver.managerId ? driver.managerId.toString() : null,
      vehicleId: driver.vehicleId ? driver.vehicleId.toString() : null,
      tripId: u.trip._id.toString(),
      lat: u.last.lat,
      lon: u.last.lon,
      speedKmh: u.last.speed,
      heading: u.last.heading,
      recordedAt: u.last.recordedAt,
      ended: u.ended,
    });
  }

  if (toPreserve.length) {
    // Keep the originals before telling the device it may forget them. ordered:false so one
    // duplicate (a re-send that beat the ack) cannot stop the rest being saved. Failure here is
    // logged, never thrown: the ack still has to go out or the queue jams again.
    try {
      await RejectedPoint.insertMany(toPreserve, { ordered: false });
    } catch (err) {
      const dupOnly = err && err.code === 11000;
      if (!dupOnly) {
        // eslint-disable-next-line no-console
        console.error('ingest: failed to preserve rejected points:', err.message);
      }
    }
  }

  if (rejectedClientIds.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `ingest: acked ${rejectedClientIds.length} unstorable point(s) from driver ${driver._id} so the device can drain its queue —`,
      rejectedClientIds.slice(0, 5)
    );
  }

  res.json({
    accepted: acceptedClientIds.length,
    acceptedClientIds,
    // Acked but not stored. Surfaced so a device dropping points is visible in the response
    // rather than only in a server log nobody is reading.
    rejected: rejectedClientIds.length,
    rejectedClientIds,
  });
});

/**
 * GET /api/tracking/my-session   (driver only)
 * Returns the driver's most recent trip (active or recently completed) + all its GPS
 * points so the mobile map screen can render the route driven this session.
 * Falls back to the latest completed/timed_out trip within the last 24 h so the
 * driver can still see their route after a trip ends.
 */
exports.mySession = asyncHandler(async (req, res) => {
  // Prefer an active trip; fall back to most recent trip from last 24 h.
  let trip = await Trip.findOne({ driverId: req.user._id, status: 'active' })
    .sort({ startedAt: -1 });

  if (!trip) {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    trip = await Trip.findOne({
      driverId: req.user._id,
      status: { $in: ['completed', 'timed_out'] },
      startedAt: { $gte: cutoff },
    }).sort({ startedAt: -1 });
  }

  if (!trip) return res.json({ trip: null, points: [] });

  const raw = await LocationPoint.find({ tripId: trip._id })
    .sort({ recordedAt: 1 })
    .select('lat lon speedKmh heading recordedAt');

  // Raw points, unmodified. `trip` carries the Valhalla-matched layer (cleanedDistanceMeters +
  // cleanedRouteShapes) once mapMatchStatus is 'matched' — see services/mapMatcher.js.
  const points = raw;

  res.json({ trip, points });
});

/**
 * GET /api/tracking/live   (admin / manager)
 * Snapshot of every currently-active trip the requester may see, with a `stale`
 * flag when the last heartbeat is older than STALE_AFTER_SECONDS.
 */
exports.live = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const now = Date.now();

  // Self-healing: drop trips that went silent past the dead-session window before building
  // the snapshot. The background watchdog does the same sweep fleet-wide on a timer; this
  // call keeps the map honest for whoever is looking at it right now.
  await closeDeadTrips(scope);

  const trips = await Trip.find({ status: 'active', ...scope })
    .populate('driverId', 'name email phone country project')
    .populate('vehicleId', 'plateNumber model');

  const withDriver = trips.filter((t) => t.driverId && t.driverId._id); // skip deleted drivers

  // "Stale" means we have lost the driver, not "the vehicle is standing still". The device stops
  // producing fixes the moment it stops moving — its 30s stationary keep-alive only emits a local
  // JS event and never reaches the server — so judging staleness on GPS alone flagged every
  // traffic light and every delivery stop. The app also heartbeats every ~30s to say it is alive;
  // a driver with a fresh heartbeat is parked or waiting, not lost.
  const liveApps = await driversWithLiveApp(
    withDriver.map((t) => t.driverId._id),
    new Date(now - env.STALE_AFTER_SECONDS * 1000)
  );

  const drivers = withDriver.map((t) => {
    const recordedAt = t.lastLocation?.recordedAt ? new Date(t.lastLocation.recordedAt).getTime() : null;
    const gpsFresh = recordedAt ? (now - recordedAt) / 1000 <= env.STALE_AFTER_SECONDS : false;
    const appAlive = liveApps.has(String(t.driverId._id));
    return {
      tripId: t._id,
      driver: t.driverId,
      vehicle: t.vehicleId,
      location: t.lastLocation,
      startedAt: t.startedAt,
      distanceMeters: t.distanceMeters,
      maxSpeedKmh: t.maxSpeedKmh,
      state: gpsFresh ? 'moving' : appAlive ? 'stopped' : 'stale',
      // Kept for older clients: still true only when we genuinely cannot account for the driver.
      stale: !gpsFresh && !appAlive,
      appAlive,
    };
  });

  res.json({ drivers, serverTime: new Date().toISOString() });
});

// Shared helper: build the trip filter + optional driver-level narrowing.
async function buildUkmTripFilter(req) {
  const { from, to, project, country, driverId } = req.query;
  const scope = await accessibleDriverFilter(req.user);
  const tripFilter = {
    status: { $in: ['completed', 'timed_out'] },
    startedAt: { $gte: new Date(from), $lte: new Date(to) },
    ...scope,
  };
  let driverIdFilter = null;
  if (driverId) {
    driverIdFilter = [driverId];
  } else if (project || country) {
    const userQuery = { role: 'user' };
    if (project) userQuery.project = project;
    if (country) userQuery.country = country;
    const matching = await User.find(userQuery).select('_id');
    driverIdFilter = matching.map(u => u._id);
  }
  if (driverIdFilter) {
    if (tripFilter.driverId && tripFilter.driverId.$in) {
      const scopeSet = new Set(tripFilter.driverId.$in.map(String));
      tripFilter.driverId = { $in: driverIdFilter.filter(id => scopeSet.has(String(id))) };
    } else {
      tripFilter.driverId = { $in: driverIdFilter };
    }
  }
  return tripFilter;
}

/**
 * GET /api/tracking/ukm   (admin / manager)
 *
 * Per-driver and fleet UKM for a date range, read straight off the figures the global engine
 * already persisted on each trip (services/globalUkm.js).
 *
 * What changed here, and why it matters more than it looks
 * -------------------------------------------------------
 * This endpoint used to take raw KM from the trips inside the date range and unique KM from that
 * driver's UkmEdge rows — which are not date-filtered at all. So a report for one week showed that
 * week's distance next to the driver's LIFETIME unique total, and the two were routinely
 * compared, divided and shown as an "overlap %". A one-day report could show 40 km driven and
 * 900 km unique.
 *
 * Now both halves come from the same trips. The date filter chooses which trips are REPORTED; the
 * history each of those trips was judged against still stretches back to the beginning of the
 * coverage scope, because that decision was made once, when the trip was attributed, and is not
 * re-litigated at read time. That is the whole point of persisting it.
 *
 * The fleet total is now a plain sum of the per-driver figures. It can be, because the ledger
 * already guarantees no two drivers hold the same piece of road — the old endpoint needed a
 * separate cross-driver dedup pass precisely because its per-driver numbers double-counted.
 *
 * Query:  ?from=ISO&to=ISO  (required)   &project=…  &country=…  &driverId=…
 */
exports.ukm = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

  const tripFilter = await buildUkmTripFilter(req);

  const trips = await Trip.find(tripFilter)
    .select(
      'driverId distanceMeters cleanedDistanceMeters distinctRoadMeters sameTripRepeatMeters ' +
        'historicalDuplicateMeters globalUniqueMeters unmatchedReviewMeters ukmStatus coverageScopeId'
    )
    .populate('driverId', 'name country project')
    .lean();

  const driverMap = {};
  for (const trip of trips) {
    const did = trip.driverId?._id?.toString() ?? trip.driverId?.toString();
    if (!did) continue;
    if (!driverMap[did]) {
      driverMap[did] = {
        driverId: did,
        name: trip.driverId?.name ?? 'Unknown',
        country: trip.driverId?.country ?? null,
        project: trip.driverId?.project ?? null,
        coverageScopeId: trip.coverageScopeId ?? null,
        rawMeters: 0,
        cleanedMeters: 0,
        distinctMeters: 0,
        repeatMeters: 0,
        duplicateMeters: 0,
        uniqueMeters: 0,
        unmatchedMeters: 0,
        trips: 0,
        // Trips whose UKM has not been established. Counted rather than folded into the totals as
        // zeros: "we drove nothing new" and "we have not worked out what we drove" are different
        // claims, and a report that cannot tell them apart is not auditable.
        pendingTrips: 0,
        reviewTrips: 0,
      };
    }
    const d = driverMap[did];
    d.rawMeters += trip.distanceMeters || 0;
    d.cleanedMeters += trip.cleanedDistanceMeters || trip.distanceMeters || 0;
    d.trips += 1;
    if (trip.globalUniqueMeters == null) {
      d.pendingTrips += 1;
      continue;
    }
    if (trip.ukmStatus === 'review') d.reviewTrips += 1;
    d.distinctMeters += trip.distinctRoadMeters || 0;
    d.repeatMeters += trip.sameTripRepeatMeters || 0;
    d.duplicateMeters += trip.historicalDuplicateMeters || 0;
    d.uniqueMeters += trip.globalUniqueMeters || 0;
    d.unmatchedMeters += trip.unmatchedReviewMeters || 0;
  }

  const km = (m) => +(m / 1000).toFixed(2);
  const drivers = Object.values(driverMap)
    .map((d) => ({
      ...d,
      rawKm: km(d.rawMeters),
      cleanedKm: km(d.cleanedMeters),
      distinctKm: km(d.distinctMeters),
      sameTripRepeatKm: km(d.repeatMeters),
      historicalDuplicateKm: km(d.duplicateMeters),
      uniqueKm: km(d.uniqueMeters),
      unmatchedKm: km(d.unmatchedMeters),
    }))
    .sort((a, b) => b.uniqueKm - a.uniqueKm);

  const sum = (f) => drivers.reduce((s, d) => s + d[f], 0);
  const totalRawKm = +sum('rawKm').toFixed(2);
  const uniqueKm = +sum('uniqueKm').toFixed(2);
  const distinctKm = +sum('distinctKm').toFixed(2);
  const duplicateKm = +sum('historicalDuplicateKm').toFixed(2);
  // Measured against DISTINCT road rather than raw distance. Raw includes GPS noise, idling and
  // self-repeat, so dividing by it produced an "overlap" that moved when the weather did. Against
  // distinct road the number means one thing only: of the road this driver actually covered, how
  // much had already been covered by the programme.
  const overlapPct = distinctKm > 0 ? +((duplicateKm / distinctKm) * 100).toFixed(1) : 0;

  res.json({
    totalRawKm,
    uniqueKm,
    distinctKm,
    duplicateKm,
    overlapPct,
    pendingTrips: drivers.reduce((s, d) => s + d.pendingTrips, 0),
    reviewTrips: drivers.reduce((s, d) => s + d.reviewTrips, 0),
    drivers,
  });
});

/**
 * POST /api/tracking/ukm-rebuild   (admin only)
 *
 * Rebuild one coverage scope's ledger and every trip figure derived from it. The explicit,
 * logged, on-purpose version of what used to happen invisibly: the old GET /ukm carried a
 * one-shot block that dropped an index, recreated the UkmEdge collection and backfilled the whole
 * fleet on whichever request happened to arrive first after a restart. A dashboard read is not
 * allowed to migrate the database, so that block is gone and this is where it lives now.
 *
 * Rewrites only CoverageSegment rows for the scope and the UKM fields on its trips. Raw GPS,
 * route geometry, raw/cleaned distances and the legacy UkmEdge collection are not touched.
 *
 * Body/query: { scopeId?, cycleId? }  — defaults to the fleet-wide scope.
 *
 * For a large history prefer the CLI (`npm run backfill:global-ukm`), which streams progress
 * instead of holding an HTTP connection open for the duration.
 */
exports.ukmRebuild = asyncHandler(async (req, res) => {
  if (!env.GLOBAL_UKM_ENABLED) {
    return res.status(409).json({ error: 'GLOBAL_UKM_ENABLED is false — nothing to rebuild' });
  }
  const scopeId = req.body?.scopeId || req.query?.scopeId || env.UKM_DEFAULT_COVERAGE_SCOPE;
  const cycleId = req.body?.cycleId || req.query?.cycleId || '';
  const summary = await rebuildScope(scopeId, cycleId);
  res.json(summary);
});

/**
 * GET /api/tracking/ukm-driver/:driverId   (admin / manager)
 *
 * One driver's trips for the UKM map, WITH the server's own verdict on which stretches were new
 * road and which were already covered.
 *
 * The shapes matter as much as the numbers. The admin page used to redraw its green "unique"
 * overlay itself, in the browser, using an ~11 m grid algorithm over only the routes it happened
 * to have loaded — a different method to the backend's, over a fraction of the backend's evidence.
 * It could and did paint a street green that the fleet had already driven, because the browser had
 * never seen the other driver's trip. So the decision is made once, here, and the client draws it.
 *
 * Query:  ?from=ISO&to=ISO  (required)
 */
exports.ukmDriver = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const { driverId } = req.params;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

  const trips = await Trip.find({
    driverId,
    status: { $in: ['completed', 'timed_out'] },
    startedAt: { $gte: new Date(from), $lte: new Date(to) },
  })
    .select(
      'startedAt endedAt distanceMeters cleanedDistanceMeters cleanedRouteShapes mapMatchStatus ' +
        'ukmStatus distinctRoadMeters sameTripRepeatMeters historicalDuplicateMeters ' +
        'globalUniqueMeters unmatchedReviewMeters ukmUniqueShapes ukmDuplicateShapes coverageScopeId'
    )
    .sort({ startedAt: 1 })
    .lean();

  // Matched trips need no point lookup at all; the unmatched ones are fetched together in a single
  // query rather than one per trip, which is what made this endpoint slow for a busy driver.
  const needRaw = trips.filter((t) => !(t.cleanedRouteShapes && t.cleanedRouteShapes.length));
  const rawByTrip = new Map(needRaw.map((t) => [String(t._id), []]));
  if (needRaw.length) {
    const pts = await LocationPoint.find({ tripId: { $in: needRaw.map((t) => t._id) } })
      .sort({ tripId: 1, recordedAt: 1 }) // matches the compound index, so no in-memory sort
      .select('tripId lat lon')
      .lean();
    for (const p of pts) {
      const arr = rawByTrip.get(String(p.tripId));
      if (arr) arr.push([p.lat, p.lon]);
    }
  }

  const routes = trips.map((trip) => {
    const base = {
      tripId: trip._id,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt,
      ukmStatus: trip.ukmStatus ?? 'pending',
      // Nulls are passed through as nulls on purpose. The client must be able to render "not yet
      // established" differently from "zero new road" — see models/Trip.js#ukmStatus.
      uniqueMeters: trip.globalUniqueMeters ?? null,
      duplicateMeters: trip.historicalDuplicateMeters ?? null,
      distinctMeters: trip.distinctRoadMeters ?? null,
    };
    return trip.cleanedRouteShapes && trip.cleanedRouteShapes.length
      ? {
        ...base,
        distanceMeters: trip.cleanedDistanceMeters || trip.distanceMeters,
        shapes: trip.cleanedRouteShapes,
        // Server-decided colouring. Null (not empty) when the trip has no verdict yet.
        uniqueShapes: trip.ukmUniqueShapes ?? null,
        duplicateShapes: trip.ukmDuplicateShapes ?? null,
        type: 'matched',
      }
      : {
        ...base,
        distanceMeters: trip.distanceMeters,
        points: rawByTrip.get(String(trip._id)) || [],
        type: 'raw',
      };
  });

  // Totals over exactly the trips listed above — no lifetime figure smuggled in beside a
  // date-filtered one, which is what made the old version of this endpoint disagree with itself.
  const acc = { raw: 0, cleaned: 0, distinct: 0, repeat: 0, duplicate: 0, unique: 0, unmatched: 0 };
  let pendingTrips = 0;
  let reviewTrips = 0;
  for (const t of trips) {
    acc.raw += t.distanceMeters || 0;
    acc.cleaned += t.cleanedDistanceMeters || t.distanceMeters || 0;
    if (t.globalUniqueMeters == null) { pendingTrips += 1; continue; }
    if (t.ukmStatus === 'review') reviewTrips += 1;
    acc.distinct += t.distinctRoadMeters || 0;
    acc.repeat += t.sameTripRepeatMeters || 0;
    acc.duplicate += t.historicalDuplicateMeters || 0;
    acc.unique += t.globalUniqueMeters || 0;
    acc.unmatched += t.unmatchedReviewMeters || 0;
  }
  const km = (m) => +(m / 1000).toFixed(2);

  res.json({
    driverId,
    trips: routes.length,
    coverageScopeId: trips[0]?.coverageScopeId ?? null,
    rawKm: km(acc.raw),
    cleanedKm: km(acc.cleaned),
    distinctKm: km(acc.distinct),
    sameTripRepeatKm: km(acc.repeat),
    historicalDuplicateKm: km(acc.duplicate),
    uniqueKm: km(acc.unique),
    unmatchedKm: km(acc.unmatched),
    pendingTrips,
    reviewTrips,
    routes,
  });
});

/**
 * GET /api/tracking/ukm-export   (admin / manager)
 *
 * CSV of the same persisted figures the dashboard reads — one query, one source, so an exported
 * number and an on-screen number cannot drift apart.
 *
 * Query:  ?from=ISO&to=ISO  (required)   &project=...  &country=...   &rows=driver|trip
 */
exports.ukmExport = asyncHandler(async (req, res) => {
  const { from, to, rows } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

  const tripFilter = await buildUkmTripFilter(req);
  const trips = await Trip.find(tripFilter)
    .select(
      'driverId projectId startedAt distanceMeters cleanedDistanceMeters cleanedMatchedRatio ' +
        'distinctRoadMeters sameTripRepeatMeters historicalDuplicateMeters globalUniqueMeters ' +
        'unmatchedReviewMeters ukmStatus ukmAlgorithmVersion coverageScopeId ukmMeters'
    )
    .populate('driverId', 'name country project')
    .sort({ startedAt: 1 })
    .lean();

  const km = (m) => (m == null ? '' : +(m / 1000).toFixed(3));
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fromDate = from.split('T')[0];
  const toDate = to.split('T')[0];

  // Per-trip rows are the auditable form: every figure traceable to one drive, with the algorithm
  // version that produced it. The per-driver rollup stays the default because that is what the
  // dashboard shows and what most people are exporting.
  if (rows === 'trip') {
    const header = [
      'Date', 'Trip ID', 'Driver', 'Project', 'Country', 'Coverage Scope',
      'Raw KM', 'Cleaned KM', 'Distinct KM', 'Same-trip Repeat KM',
      'Historical Duplicate KM', 'Unique KM', 'Unmatched/Review KM',
      'UKM Status', 'Map Match Ratio', 'UKM Algorithm Version',
      // The superseded per-driver figure, carried alongside the global one so the two can be
      // compared in a spreadsheet during cutover. The gap between this column and 'Unique KM' is
      // road the driver had not personally driven but the fleet already had — what the old logic
      // credited twice. Drop this column once the new numbers are signed off.
      'Legacy Per-Driver UKM',
    ].join(',');
    const body = trips.map((t) => [
      esc(new Date(t.startedAt).toISOString().slice(0, 10)),
      esc(t._id),
      esc(t.driverId?.name ?? 'Unknown'),
      esc(t.driverId?.project ?? ''),
      esc(t.driverId?.country ?? ''),
      esc(t.coverageScopeId ?? ''),
      km(t.distanceMeters), km(t.cleanedDistanceMeters), km(t.distinctRoadMeters),
      km(t.sameTripRepeatMeters), km(t.historicalDuplicateMeters), km(t.globalUniqueMeters),
      km(t.unmatchedReviewMeters),
      esc(t.ukmStatus ?? 'pending'),
      t.cleanedMatchedRatio == null ? '' : +t.cleanedMatchedRatio.toFixed(3),
      esc(t.ukmAlgorithmVersion ?? ''),
      km(t.ukmMeters),
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ukm-trips-${fromDate}-to-${toDate}.csv"`);
    return res.send([header, ...body].join('\n'));
  }

  const driverMap = {};
  for (const trip of trips) {
    const did = trip.driverId?._id?.toString() ?? trip.driverId?.toString();
    if (!did) continue;
    if (!driverMap[did]) {
      driverMap[did] = {
        name: trip.driverId?.name ?? 'Unknown',
        country: trip.driverId?.country ?? '',
        project: trip.driverId?.project ?? '',
        scope: trip.coverageScopeId ?? '',
        raw: 0, cleaned: 0, distinct: 0, repeat: 0, duplicate: 0, unique: 0, unmatched: 0,
        trips: 0, pending: 0, review: 0,
      };
    }
    const d = driverMap[did];
    d.raw += trip.distanceMeters || 0;
    d.cleaned += trip.cleanedDistanceMeters || trip.distanceMeters || 0;
    d.trips += 1;
    if (trip.globalUniqueMeters == null) { d.pending += 1; continue; }
    if (trip.ukmStatus === 'review') d.review += 1;
    d.distinct += trip.distinctRoadMeters || 0;
    d.repeat += trip.sameTripRepeatMeters || 0;
    d.duplicate += trip.historicalDuplicateMeters || 0;
    d.unique += trip.globalUniqueMeters || 0;
    d.unmatched += trip.unmatchedReviewMeters || 0;
  }

  const list = Object.values(driverMap).sort((a, b) => b.unique - a.unique);
  const header = [
    'Driver', 'Project', 'Country', 'Coverage Scope', 'Trips',
    'Raw KM', 'Cleaned KM', 'Distinct KM', 'Same-trip Repeat KM',
    'Historical Duplicate KM', 'Unique KM', 'Unmatched/Review KM',
    'Overlap %', 'Trips Pending', 'Trips In Review',
  ].join(',');
  const body = list.map((d) => [
    esc(d.name), esc(d.project), esc(d.country), esc(d.scope), d.trips,
    km(d.raw), km(d.cleaned), km(d.distinct), km(d.repeat),
    km(d.duplicate), km(d.unique), km(d.unmatched),
    // Against distinct road, matching the dashboard — see the note in exports.ukm.
    d.distinct > 0 ? +((d.duplicate / d.distinct) * 100).toFixed(1) : 0,
    d.pending, d.review,
  ].join(','));

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ukm-report-${fromDate}-to-${toDate}.csv"`);
  res.send([header, ...body].join('\n'));
});

/**
 * GET /api/tracking/parked   (admin / manager)
 * Returns the most recent completed/timed_out trip per driver (ended within the last 8 h)
 * so the live map can show inactive vehicles at their last known parking position.
 * Excludes drivers who currently have an active trip (they appear in /live already).
 */
exports.parked = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const cutoff = new Date(Date.now() - env.PARKED_VISIBLE_DAYS * 24 * 60 * 60 * 1000);

  // Drivers who are currently active — exclude them from the parked view.
  const activeTrips = await Trip.find({ status: 'active', ...scope }).select('driverId');
  const activeDriverIds = activeTrips.map((t) => t.driverId.toString());

  const recentEnded = await Trip.find({
    status: { $in: ['completed', 'timed_out'] },
    endedAt: { $gte: cutoff },
    lastLocation: { $ne: null },
    ...scope,
  })
    .populate('driverId', 'name email phone country project')
    .populate('vehicleId', 'plateNumber model')
    .sort({ endedAt: -1 });

  // Keep only the most recent trip per driver, skip active drivers.
  const seen = new Set();
  const parked = [];
  for (const t of recentEnded) {
    const dId = t.driverId?._id?.toString() ?? t.driverId?.toString();
    if (!dId || !t.driverId?._id || seen.has(dId) || activeDriverIds.includes(dId)) continue;
    seen.add(dId);
    parked.push({
      tripId: t._id,
      driver: t.driverId,
      vehicle: t.vehicleId,
      location: t.lastLocation,
      endedAt: t.endedAt,
      // How long it has been sitting there, so the map can say "parked 3 days" rather than
      // leaving the reader to subtract timestamps.
      parkedForSeconds: t.endedAt ? Math.max(0, Math.round((Date.now() - new Date(t.endedAt).getTime()) / 1000)) : null,
    });
  }

  res.json({ parked });
});

/**
 * GET /api/tracking/my-areas   (driver only)
 *
 * The work areas this driver is currently responsible for, so the app can show them what they are
 * meant to be covering today rather than the driver having to be told over the phone.
 *
 * Two things govern the shape of this response, both learned the hard way:
 *
 *  1. It serves `outline` — the 25 m-simplified copy — and NEVER the full geometry. Full geometry
 *     for the first delivery is 7.4 MB; a single large rural area can be hundreds of KB of it. This
 *     is a mobile connection on a metered plan, on a fleet that just produced a 25 GB month.
 *  2. It only ever returns areas from the ACTIVE network version of the driver's project(s). A
 *     superseded version's assignments are history, not today's work.
 */
exports.myAreas = asyncHandler(async (req, res) => {
  const driver = req.user;
  const projectIds = (driver.projectIds || []).map(String);
  if (!projectIds.length) return res.json({ areas: [], updatedAt: null });

  const activeVersions = await NetworkVersion.find({
    projectId: { $in: projectIds },
    status: 'active',
  }).select('_id label projectId');
  if (!activeVersions.length) return res.json({ areas: [], updatedAt: null });

  const assignments = await AreaAssignment.find({
    driverId: driver._id,
    releasedAt: null,
  }).select('areaId areaCode assignedAt note networkVersionId');
  if (!assignments.length) return res.json({ areas: [], updatedAt: null });

  /**
   * Resolve assignments by AREA CODE against the active version, not by networkVersionId.
   *
   * An AreaAssignment stores the version it was made against. Re-importing the network mints a new
   * version with new WorkArea _ids, so every existing assignment instantly pointed at a superseded
   * version and silently vanished from the driver's app — with nothing in the UI to explain why.
   * That happened repeatedly here: five versions, and both live assignments stranded.
   *
   * `areaCode` is the CUSTOMER's identifier (an ABS SA2 code) and is stable across deliveries, so
   * matching on it means "Wallan is assigned to this driver" survives any number of re-imports.
   * The stored networkVersionId is kept as history — it records which delivery the decision was
   * made against — but it is no longer what entitlement depends on.
   */
  const activeIds = activeVersions.map((v) => v._id);
  const codes = [...new Set(assignments.map((a) => a.areaCode).filter(Boolean))];
  const legacyIds = assignments.filter((a) => !a.areaCode).map((a) => a.areaId);

  const areas = await WorkArea.find({
    networkVersionId: { $in: activeIds },
    // Rows predating the areaCode snapshot fall back to the raw id.
    $or: [{ areaCode: { $in: codes } }, { _id: { $in: legacyIds } }],
  }).select('areaCode name parentName priority targetMeters targetLinks outline bbox');

  // Keyed by code so the stamp follows the area across versions, with an id fallback for legacy.
  const assignedAtByCode = new Map(
    assignments.filter((a) => a.areaCode).map((a) => [a.areaCode, a.assignedAt])
  );
  const assignedAtById = new Map(assignments.map((a) => [String(a.areaId), a.assignedAt]));
  const assignedAtByArea = new Map(
    areas.map((a) => [
      String(a._id),
      assignedAtByCode.get(a.areaCode) || assignedAtById.get(String(a._id)) || null,
    ])
  );

  // Newest assignment stamp doubles as a cheap cache key: the app can skip redrawing (and skip
  // re-fetching geometry) while this has not moved.
  const updatedAt = assignments.reduce(
    (latest, a) => (!latest || a.assignedAt > latest ? a.assignedAt : latest),
    null
  );

  res.json({
    updatedAt,
    areas: areas.map((a) => ({
      id: String(a._id),
      areaCode: a.areaCode,
      name: a.name,
      parentName: a.parentName,
      priority: a.priority,
      targetMeters: a.targetMeters,
      targetLinks: a.targetLinks,
      bbox: a.bbox,
      // May be absent on areas imported before outlines were stored; the app falls back to bbox.
      outline: a.outline && a.outline.coordinates ? a.outline : null,
      assignedAt: assignedAtByArea.get(String(a._id)) || null,
    })),
  });
});

/**
 * Send a JSON body gzipped, when the client says it can take it.
 *
 * This app has NO compression middleware — nothing in app.js compresses anything, and
 * `compression` is not even a dependency. That is survivable for the rest of the API, whose
 * responses are kilobytes. It is not survivable for my-roads: one full area measures ~2.5 MB of
 * JSON, and every byte of it crosses a driver's metered mobile plan. gzip takes that to ~0.5 MB.
 * Shipping the uncompressed version would undo the whole reason the payload is positional tuples
 * instead of GeoJSON in the first place.
 *
 * Done here rather than by adding middleware in app.js because this is the only route in the file
 * that is megabytes large, and a blanket middleware would also start compressing the 10-second
 * ingest acks, where the CPU is pure loss.
 *
 * zlib.gzip and not gzipSync: 2.5 MB takes ~80 ms to compress, and gzipSync spends all of it on
 * the event loop, stalling every other request on this single-process API. The async form runs on
 * the threadpool.
 *
 * Cache-Control makes the response storable-but-revalidated, which lets Express's own ETag turn
 * the common case — driver reopens the map, coverage has not moved — into an empty 304 instead of
 * a second half-megabyte. `private` because the body is one driver's assigned network and must
 * never sit in a shared proxy cache.
 */
const gzip = promisify(zlib.gzip);

async function sendCompressed(req, res, body) {
  const json = JSON.stringify(body);
  res.set('Cache-Control', 'private, no-cache');
  // Without Vary, a cache that stored the gzipped body could hand it to a client that never asked
  // for gzip and cannot decode it.
  res.set('Vary', 'Accept-Encoding');
  res.type('application/json');

  if (!req.acceptsEncodings('gzip')) return res.send(json);

  try {
    const packed = await gzip(json, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
    res.set('Content-Encoding', 'gzip');
    return res.send(packed);
  } catch (err) {
    // Compression failing is not a reason to fail the request — the driver still needs the map.
    // Logged rather than swallowed so a systematically failing zlib is visible instead of just
    // showing up as an unexplained bandwidth bill.
    console.error('[my-roads] gzip failed, sending uncompressed:', err.message);
    res.removeHeader('Content-Encoding');
    return res.send(json);
  }
}

/**
 * GET /api/tracking/my-roads?areaId=…   (driver only)
 *
 * The individual roads inside one of the driver's areas, each flagged driven or not, so the app can
 * paint outstanding streets red and finished ones blue instead of showing a bare polygon and
 * leaving the driver to guess which streets inside it still need doing.
 *
 * The interesting decisions all live in services/driverRoads.js — why the driver's roads are
 * derived from the polygon rather than stored per link, why the payload is positional tuples, and
 * how `version` lets the app cache the response instead of re-pulling it.
 *
 * Handler stays thin on purpose: this endpoint has one non-obvious rule (entitlement) and one
 * expensive body, and neither belongs in a file that is already 800 lines of ingest logic. The one
 * thing it does own is getting the body onto the wire compressed — see sendCompressed.
 */
exports.myRoads = asyncHandler(async (req, res) => {
  const areaId = String(req.query.areaId || '');
  // Shape-checked before it reaches Mongo. A malformed id would otherwise throw a CastError out of
  // the assignment query and surface as a 500 for what is really a bad request.
  if (!/^[a-f\d]{24}$/i.test(areaId)) {
    return res.status(400).json({ error: 'areaId query param is required' });
  }

  const roads = await getDriverRoads({
    driverId: req.user._id,
    // Entitlement is assignment AND current project membership; see authoriseArea.
    projectIds: req.user.projectIds,
    areaId,
  });
  // One message for every failed entitlement — not assigned, released last month, assigned on a
  // superseded version, or moved off the project. Which one it is tells a prober something about
  // the customer's network.
  if (!roads) return res.status(403).json({ error: 'You are not assigned to this area' });

  await sendCompressed(req, res, roads);
});
