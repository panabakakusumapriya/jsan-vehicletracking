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
const { computeTripUkm } = require('../services/ukmCompute');
const UkmEdge = require('../models/UkmEdge');
const mongoose = require('mongoose');

let _ukmBackfillDone = false;

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
            },
            $unset: { cleanedRouteShapes: 1, ukmNewShapes: 1, endLocation: 1 },
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
 * Fast read: aggregates raw KM from trips + unique KM from the pre-computed UkmEdge
 * collection.  No location-point scan — UKM edges are inserted at trip completion.
 *
 * Query:  ?from=ISO&to=ISO  (required)   &project=…  &country=…  &driverId=…
 */
exports.ukm = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

  const tripFilter = await buildUkmTripFilter(req);

  // 1) Raw KM from trips.
  const trips = await Trip.find(tripFilter)
    .select('driverId distanceMeters')
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
        rawMeters: 0,
        uniqueMeters: 0,
        trips: 0,
      };
    }
    driverMap[did].rawMeters += trip.distanceMeters || 0;
    driverMap[did].trips += 1;
  }

  // One-time per server lifetime: ensure compound index exists and backfill
  // any trips that are missing edges.
  if (!_ukmBackfillDone) {
    _ukmBackfillDone = true;

    // Migrate from old schema (unique on edgeKey alone) if needed.
    let needsDrop = false;
    try {
      const indexes = await UkmEdge.collection.indexes();
      const hasOldUnique = indexes.some(idx =>
        idx.unique && idx.key && idx.key.edgeKey === 1 && !idx.key.driverId
      );
      if (hasOldUnique) needsDrop = true;
    } catch (_) { /* collection doesn't exist yet — fine */ }

    if (needsDrop) {
      try { await UkmEdge.collection.drop(); } catch (_) {}
    }
    await UkmEdge.syncIndexes();

    // Find trips that have NOT been processed yet: completed/timed_out trips
    // whose _id does not appear in any UkmEdge.tripId.
    const processedTripIds = await UkmEdge.distinct('tripId');
    const processedSet = new Set(processedTripIds.map(String));

    const allTrips = await Trip.find({
      status: { $in: ['completed', 'timed_out'] },
    }).select('_id driverId').lean();

    const unprocessed = allTrips.filter(t => !processedSet.has(t._id.toString()));

    // Skip trips whose location points no longer exist. computeTripUkm reads LocationPoints, so
    // these can never yield an edge and can never leave the "unprocessed" list — meaning the loop
    // below re-scanned all of them on the first request after EVERY restart, forever. Measured at
    // ~71 ms each across 239 such trips: ~17 seconds added to whoever opened this page first.
    // They are the trips whose points were bulk-deleted (everything before 2026-08-04); nothing
    // here can recover them, so the only sane action is not to keep asking.
    const withPoints = [];
    for (const t of unprocessed) {
      const probe = await LocationPoint.find({ tripId: t._id }).select('_id').limit(2).lean();
      if (probe.length >= 2) withPoints.push(t);
    }

    for (const t of withPoints) {
      await computeTripUkm(t._id, t.driverId);
    }
  }

  // 2) Unique KM from pre-computed edges — aggregate per driver.
  const driverIds = Object.keys(driverMap);
  const driverObjectIds = driverIds.map(id => new mongoose.Types.ObjectId(id));
  const edgeAgg = await UkmEdge.aggregate([
    { $match: { driverId: { $in: driverObjectIds } } },
    { $group: { _id: '$driverId', uniqueMeters: { $sum: '$distanceMeters' } } },
  ]);
  for (const row of edgeAgg) {
    const did = row._id.toString();
    if (driverMap[did]) driverMap[did].uniqueMeters = row.uniqueMeters;
  }

  // Fleet-wide UKM: deduplicate edges across drivers — group by edgeKey first to
  // collapse the same road driven by different drivers, then sum.
  const fleetMatch = driverObjectIds.length
    ? { driverId: { $in: driverObjectIds } }
    : {};
  const fleetAgg = await UkmEdge.aggregate([
    { $match: fleetMatch },
    { $group: { _id: '$edgeKey', dist: { $first: '$distanceMeters' } } },
    { $group: { _id: null, total: { $sum: '$dist' } } },
  ]);
  const fleetUniqueMeters = fleetAgg[0]?.total ?? 0;

  const drivers = Object.values(driverMap)
    .map(d => ({
      ...d,
      rawKm: +(d.rawMeters / 1000).toFixed(2),
      uniqueKm: +(d.uniqueMeters / 1000).toFixed(2),
    }))
    .sort((a, b) => b.uniqueKm - a.uniqueKm);

  const totalRawKm = +drivers.reduce((s, d) => s + d.rawKm, 0).toFixed(2);
  const uniqueKm = +(fleetUniqueMeters / 1000).toFixed(2);
  const overlapPct = totalRawKm > 0 ? +((1 - uniqueKm / totalRawKm) * 100).toFixed(1) : 0;

  res.json({ totalRawKm, uniqueKm, overlapPct, drivers });
});

/**
 * POST /api/tracking/ukm-backfill   (admin only)
 * One-time backfill: compute UKM edges for all completed trips that don't have edges yet.
 * Safe to run multiple times — insertMany skips existing edges.
 */
exports.ukmBackfill = asyncHandler(async (req, res) => {
  const processedTripIds = await UkmEdge.distinct('tripId');
  const processedSet = new Set(processedTripIds.map(String));

  const allTrips = await Trip.find({
    status: { $in: ['completed', 'timed_out'] },
  }).select('_id driverId').lean();

  const unprocessed = allTrips.filter(t => !processedSet.has(t._id.toString()));

  let processed = 0;
  let newEdges = 0;
  for (const trip of unprocessed) {
    const n = await computeTripUkm(trip._id, trip.driverId);
    newEdges += n;
    processed += 1;
  }
  res.json({ total: allTrips.length, alreadyProcessed: allTrips.length - unprocessed.length, processed, newEdges });
});

/**
 * GET /api/tracking/ukm-driver/:driverId   (admin / manager)
 * Returns a single driver's trip routes for UKM map view.
 * Each trip includes its cleaned route shapes (if matched) or raw points as a fallback.
 * Also returns the driver's unique edge count & total unique meters.
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
    .select('startedAt endedAt distanceMeters cleanedDistanceMeters cleanedRouteShapes mapMatchStatus')
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

  const routes = trips.map((trip) =>
    trip.cleanedRouteShapes && trip.cleanedRouteShapes.length
      ? {
        tripId: trip._id,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        distanceMeters: trip.cleanedDistanceMeters || trip.distanceMeters,
        shapes: trip.cleanedRouteShapes,
        type: 'matched',
      }
      : {
        tripId: trip._id,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        distanceMeters: trip.distanceMeters,
        points: rawByTrip.get(String(trip._id)) || [],
        type: 'raw',
      }
  );

  // Driver's per-driver unique meters.
  const driverOid = new mongoose.Types.ObjectId(driverId);
  const edgeAgg = await UkmEdge.aggregate([
    { $match: { driverId: driverOid } },
    { $group: { _id: null, uniqueMeters: { $sum: '$distanceMeters' }, edgeCount: { $sum: 1 } } },
  ]);
  const uniqueMeters = edgeAgg[0]?.uniqueMeters ?? 0;
  const edgeCount = edgeAgg[0]?.edgeCount ?? 0;
  const rawMeters = trips.reduce((s, t) => s + (t.distanceMeters || 0), 0);

  res.json({
    driverId,
    trips: routes.length,
    rawKm: +(rawMeters / 1000).toFixed(2),
    uniqueKm: +(uniqueMeters / 1000).toFixed(2),
    edgeCount,
    routes,
  });
});

/**
 * GET /api/tracking/ukm-export   (admin / manager)
 * CSV export of the UKM data.
 * Query:  ?from=ISO&to=ISO  (required)   &project=…  &country=…
 */
exports.ukmExport = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });

  const tripFilter = await buildUkmTripFilter(req);
  const trips = await Trip.find(tripFilter)
    .select('driverId distanceMeters')
    .populate('driverId', 'name country project')
    .lean();

  const driverMap = {};
  for (const trip of trips) {
    const did = trip.driverId?._id?.toString() ?? trip.driverId?.toString();
    if (!did) continue;
    if (!driverMap[did]) {
      driverMap[did] = {
        name: trip.driverId?.name ?? 'Unknown',
        country: trip.driverId?.country ?? '',
        project: trip.driverId?.project ?? '',
        rawMeters: 0,
        uniqueMeters: 0,
        trips: 0,
      };
    }
    driverMap[did].rawMeters += trip.distanceMeters || 0;
    driverMap[did].trips += 1;
  }

  const driverIds = Object.keys(driverMap);
  const driverObjectIds = driverIds.map(id => new mongoose.Types.ObjectId(id));
  const edgeAgg = await UkmEdge.aggregate([
    { $match: { driverId: { $in: driverObjectIds } } },
    { $group: { _id: '$driverId', uniqueMeters: { $sum: '$distanceMeters' } } },
  ]);
  for (const row of edgeAgg) {
    const did = row._id.toString();
    if (driverMap[did]) driverMap[did].uniqueMeters = row.uniqueMeters;
  }

  const rows = Object.values(driverMap)
    .map(d => ({
      ...d,
      rawKm: +(d.rawMeters / 1000).toFixed(2),
      uniqueKm: +(d.uniqueMeters / 1000).toFixed(2),
      overlapPct: d.rawMeters > 0 ? +((1 - d.uniqueMeters / d.rawMeters) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.uniqueKm - a.uniqueKm);

  const fromDate = from.split('T')[0];
  const toDate = to.split('T')[0];
  const header = 'Driver,Project,Country,Trips,Total KM,Unique KM,Overlap %';
  const csv = [header, ...rows.map(r =>
    `"${r.name}","${r.project}","${r.country}",${r.trips},${r.rawKm},${r.uniqueKm},${r.overlapPct}%`
  )].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="ukm-report-${fromDate}-to-${toDate}.csv"`);
  res.send(csv);
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
    networkVersionId: { $in: activeVersions.map((v) => v._id) },
  }).select('areaId assignedAt note');
  if (!assignments.length) return res.json({ areas: [], updatedAt: null });

  // One query for the geometry, not one per assignment.
  const areas = await WorkArea.find({
    _id: { $in: assignments.map((a) => a.areaId) },
  }).select('areaCode name parentName priority targetMeters targetLinks outline bbox');

  const assignedAtByArea = new Map(assignments.map((a) => [String(a.areaId), a.assignedAt]));

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
