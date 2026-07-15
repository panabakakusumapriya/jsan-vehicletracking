const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const asyncHandler = require('../utils/asyncHandler');
const { haversineMeters } = require('../utils/geo');
const { accessibleDriverFilter } = require('../utils/scope');
const { emitLocation } = require('../realtime/io');
const env = require('../config/env');

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
 * Returns { accepted, acceptedClientIds } — the device deletes those local rows.
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
        status: 'active',
        startedAt: new Date(first.recordedAt),
        startLocation: { lat: first.lat, lon: first.lon },
      });
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

      try {
        await LocationPoint.create(doc);
      } catch (e) {
        if (e.code === 11000) {
          // Already ingested (duplicate clientId) — safe to ack so device can delete it.
          if (p.clientId) acceptedClientIds.push(p.clientId);
          continue;
        }
        throw e;
      }

      if (p.clientId) acceptedClientIds.push(p.clientId);
      if (last) addedDistance += haversineMeters(last, { lat: p.lat, lon: p.lon });
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

  res.json({ accepted: acceptedClientIds.length, acceptedClientIds });
});

/**
 * GET /api/tracking/my-session   (driver only)
 * Returns the driver's current active trip + all its GPS points so the
 * mobile map screen can render the route driven this session.
 */
exports.mySession = asyncHandler(async (req, res) => {
  const trip = await Trip.findOne({ driverId: req.user._id, status: 'active' })
    .sort({ startedAt: -1 });

  if (!trip) return res.json({ trip: null, points: [] });

  const points = await LocationPoint.find({ tripId: trip._id })
    .sort({ recordedAt: 1 })
    .select('lat lon speedKmh heading recordedAt');

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

  // Self-healing: an active trip that hasn't reported for longer than the dead-session
  // window isn't live — it's a leftover (app killed, crashed/reinstalled session, or a
  // very long signal loss). Close it so it stops showing up as a permanent "stale" marker.
  // Offline-buffered points that arrive later still append to the (now closed) trip, so the
  // recorded route is preserved; it just won't reappear as a live driver.
  const deadCutoff = new Date(now - env.SESSION_DEAD_AFTER_SECONDS * 1000);
  await Trip.updateMany(
    {
      status: 'active',
      ...scope,
      $or: [
        { 'lastLocation.recordedAt': { $lt: deadCutoff } },
        { lastLocation: null, startedAt: { $lt: deadCutoff } },
      ],
    },
    { $set: { status: 'timed_out', endedAt: new Date() } }
  );

  const trips = await Trip.find({ status: 'active', ...scope })
    .populate('driverId', 'name email phone')
    .populate('vehicleId', 'plateNumber model');

  const drivers = trips.map((t) => {
    const recordedAt = t.lastLocation?.recordedAt ? new Date(t.lastLocation.recordedAt).getTime() : null;
    return {
      tripId: t._id,
      driver: t.driverId,
      vehicle: t.vehicleId,
      location: t.lastLocation,
      startedAt: t.startedAt,
      distanceMeters: t.distanceMeters,
      maxSpeedKmh: t.maxSpeedKmh,
      stale: recordedAt ? (now - recordedAt) / 1000 > env.STALE_AFTER_SECONDS : true,
    };
  });

  res.json({ drivers, serverTime: new Date().toISOString() });
});
