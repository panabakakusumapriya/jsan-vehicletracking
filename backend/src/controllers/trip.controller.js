const archiver = require('archiver');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { buildKml, buildJson, buildMergedKml, buildMergedJson, baseFilename, driverName, vehiclePlate, slug, filenameDate } = require('../utils/tripExport');

// GET /api/trips?status=&driverId=&from=&to=&limit=&page=
//
// from/to are plain YYYY-MM-DD strings, matched with no timezone conversion: `from` parses as
// UTC midnight, `to` parses in the server's own local time. Deliberate — this endpoint does
// not know or care what timezone the viewer or the driver is in. See the Trips page for how
// the result is displayed (also deliberately viewer-local, with no conversion either).
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) {
    filter.driverId = req.query.driverId;
  } else if (req.query.driverIds !== undefined) {
    // Present-but-possibly-empty means "match exactly this set" — a project/country combo
    // that resolves to zero drivers must return zero trips, not silently fall through to
    // "no filter at all" and show the whole fleet. `{ $in: [] }` correctly matches nothing.
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    filter.driverId = { $in: ids };
  }
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(`${req.query.to}T23:59:59`);
  }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);

  const [trips, total] = await Promise.all([
    Trip.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('driverId', 'name email')
      .populate('vehicleId', 'plateNumber'),
    Trip.countDocuments(filter),
  ]);

  res.json({ trips, total, page, limit });
});

// GET /api/trips/:id  (+ ?points=true for the full path)
exports.getOne = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const trip = await Trip.findOne({ _id: req.params.id, ...scope })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  let points;
  if (req.query.points === 'true') {
    const raw = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');

    // Raw points — no cleaning. OSRM road-snapping will be added later.
    points = raw;
  }
  res.json({ trip, points });
});

// GET /api/trips/:id/export?format=kml|json
exports.exportOne = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const trip = await Trip.findOne({ _id: req.params.id, ...scope })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const points = await LocationPoint.find({ tripId: trip._id })
    .sort({ recordedAt: 1 })
    .select('lat lon speedKmh heading recordedAt');

  const filename = baseFilename(trip);
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.send(JSON.stringify(buildJson(trip, points), null, 2));
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
  res.send(buildKml(trip, points));
});

// GET /api/trips/export-merged?driverId=&date=&format=kml|json
// Merges ALL trips for a single driver on a single date into one file.
exports.exportMerged = asyncHandler(async (req, res) => {
  const { driverId, date, format: fmt } = req.query;
  const format = fmt === 'json' ? 'json' : 'kml';
  if (!driverId || !date) return res.status(400).json({ error: 'driverId and date are required' });

  const scope = await accessibleDriverFilter(req.user);
  const dayStart = new Date(date);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: dayStart, $lte: dayEnd },
    ...scope,
  })
    .sort({ startedAt: 1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  if (!trips.length) return res.status(404).json({ error: 'No trips found for this driver on this date' });

  const tripsWithPoints = [];
  for (const trip of trips) {
    const points = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');
    tripsWithPoints.push({ trip, points });
  }

  const dName = driverName(trips[0]);
  const vPlate = vehiclePlate(trips[0]);
  const filename = `merged_${slug(dName)}_${date}`;

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.send(JSON.stringify(buildMergedJson(dName, vPlate, date, tripsWithPoints), null, 2));
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
  res.send(buildMergedKml(dName, vPlate, date, tripsWithPoints));
});

// GET /api/trips/merged-points?driverId=&date=
// Returns all points for a driver on a single date, merged across trips, for map display.
exports.mergedPoints = asyncHandler(async (req, res) => {
  const { driverId, date } = req.query;
  if (!driverId || !date) return res.status(400).json({ error: 'driverId and date are required' });

  const scope = await accessibleDriverFilter(req.user);
  const dayStart = new Date(date);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: dayStart, $lte: dayEnd },
    ...scope,
  })
    .sort({ startedAt: 1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  const tripsData = [];
  let totalDistance = 0;
  let maxSpeed = 0;
  let totalPoints = 0;

  for (const trip of trips) {
    const raw = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');
    const points = raw;
    tripsData.push({
      tripId: trip._id,
      status: trip.status,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt,
      distanceMeters: trip.distanceMeters,
      maxSpeedKmh: trip.maxSpeedKmh,
      points,
    });
    totalDistance += trip.distanceMeters || 0;
    maxSpeed = Math.max(maxSpeed, trip.maxSpeedKmh || 0);
    totalPoints += points.length;
  }

  res.json({
    driverName: trips.length ? driverName(trips[0]) : '',
    vehiclePlate: trips.length ? vehiclePlate(trips[0]) : null,
    date,
    totalTrips: trips.length,
    totalDistance,
    maxSpeed,
    totalPoints,
    trips: tripsData,
  });
});

// GET /api/trips/merged-summary?limit=&page=
// Returns grouped driver+date trip summaries for the reports overview.
exports.mergedSummary = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);

  const matchStage = Object.keys(scope).length ? scope : {};

  const pipeline = [
    { $match: matchStage },
    {
      $addFields: {
        dateStr: {
          $dateToString: { format: '%Y-%m-%d', date: '$startedAt' },
        },
      },
    },
    {
      $group: {
        _id: { driverId: '$driverId', date: '$dateStr' },
        totalTrips: { $sum: 1 },
        totalDistance: { $sum: '$distanceMeters' },
        maxSpeed: { $max: '$maxSpeedKmh' },
        firstStart: { $min: '$startedAt' },
        lastEnd: { $max: '$endedAt' },
      },
    },
    { $sort: { firstStart: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
  ];

  const results = await Trip.aggregate(pipeline);

  const User = require('../models/User');
  const driverIds = [...new Set(results.map((r) => r._id.driverId.toString()))];
  const users = await User.find({ _id: { $in: driverIds } }).select('name');
  const userMap = Object.fromEntries(users.map((u) => [u._id.toString(), u.name]));

  const summaries = results.map((r) => ({
    driverId: r._id.driverId,
    driverName: userMap[r._id.driverId.toString()] || 'Unknown',
    date: r._id.date,
    totalTrips: r.totalTrips,
    totalDistance: r.totalDistance || 0,
    maxSpeed: r.maxSpeed || 0,
    firstStart: r.firstStart,
    lastEnd: r.lastEnd,
  }));

  res.json({ summaries });
});

// GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=
exports.exportBulk = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) {
    filter.driverId = req.query.driverId;
  } else if (req.query.driverIds !== undefined) {
    // Present-but-possibly-empty means "match exactly this set" — see the identical comment
    // on list() above. Exporting "my project" must never silently fall back to exporting
    // everyone just because that project currently has zero drivers.
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    filter.driverId = { $in: ids };
  }
  // Same no-conversion matching as list() above: from parses as UTC midnight, to parses in
  // the server's own local time. No per-driver or per-trip timezone awareness here either.
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(`${req.query.to}T23:59:59`);
  }

  const trips = await Trip.find(filter)
    .sort({ startedAt: -1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  const rangeLabel = req.query.from || req.query.to ? `${req.query.from || 'start'}_${req.query.to || 'now'}` : 'all';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="trips_${rangeLabel}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.destroy(err));
  archive.pipe(res);

  for (const trip of trips) {
    const points = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');
    const filename = baseFilename(trip);
    if (format === 'json') {
      archive.append(JSON.stringify(buildJson(trip, points), null, 2), { name: `${filename}.json` });
    } else {
      archive.append(buildKml(trip, points), { name: `${filename}.kml` });
    }
  }

  await archive.finalize();
});
