const archiver = require('archiver');
const mongoose = require('mongoose');
const Trip = require('../models/Trip');
const User = require('../models/User');
const LocationPoint = require('../models/LocationPoint');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { dayRange } = require('../utils/timezone');
const { timezoneForCountry } = require('../utils/countryTimezone');
const { buildKml, buildJson, buildMergedKml, buildMergedJson, baseFilename, driverName, vehiclePlate, slug, filenameDate } = require('../utils/tripExport');

// Shared by list(), exportBulk() and mergedSummary() — the exact same status/driverId(s)/date
// filtering rules apply everywhere trips get filtered, so this is the one place that logic
// lives rather than three copies drifting apart.
//
// from/to are plain YYYY-MM-DD strings, matched with no timezone conversion: `from` parses as
// UTC midnight, `to` parses in the server's own local time. Deliberate — this endpoint does
// not know or care what timezone the viewer or the driver is in. See the Trips page for how
// the result is displayed (also deliberately viewer-local, with no conversion either).
// A query-string id is always a plain string. Mongoose auto-casts a string to ObjectId for
// .find()-style queries, but NOT inside .aggregate() pipelines (mergedSummary uses this same
// filter in a $match stage) — those hit MongoDB directly with whatever's in the pipeline, and
// a string never equals an ObjectId under Mongo's own comparison, so an uncast id here would
// silently match zero documents in an aggregation while working fine in .find(). Casting
// explicitly makes this filter correct for both. Falls back to the raw string for something
// that isn't a valid ObjectId, so .find() still produces its own CastError as before rather
// than this function swallowing bad input silently.
const toObjectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);

function buildTripFilter(req, scope) {
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) {
    filter.driverId = toObjectId(req.query.driverId);
  } else if (req.query.driverIds !== undefined) {
    // Present-but-possibly-empty means "match exactly this set" — a project/country combo
    // that resolves to zero drivers must return zero trips, not silently fall through to
    // "no filter at all" and show the whole fleet. `{ $in: [] }` correctly matches nothing.
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    filter.driverId = { $in: ids.map(toObjectId) };
  }
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(`${req.query.to}T23:59:59`);
  }
  return filter;
}

// GET /api/trips?status=&driverId=&from=&to=&limit=&page=
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);

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
  const driver = await User.findById(driverId).select('country');
  const tz = timezoneForCountry(driver?.country);
  let range;
  try {
    range = dayRange(date, tz);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: range.from, $lt: range.to },
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
  const driver = await User.findById(driverId).select('country');
  const tz = timezoneForCountry(driver?.country);
  let range;
  try {
    range = dayRange(date, tz);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: range.from, $lt: range.to },
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
    timezone: tz,
    totalTrips: trips.length,
    totalDistance,
    maxSpeed,
    totalPoints,
    trips: tripsData,
  });
});

// GET /api/trips/merged-summary?status=&driverId=&driverIds=&from=&to=&limit=&page=
//
// One row per driver+calendar-day (the Trips page's grouped view, and the Reports overview).
// Same status/driverId(s)/date filters as list()/exportBulk() — a manager filtering Trips by
// project must see that same scoping reflected in the grouped view, not just the flat one.
//
// Paginates over DAY-GROUPS, not raw trips: `total` is the number of distinct driver+day rows
// matching the filter, computed in the same aggregation pass (via $facet) rather than a second
// query, so the count can never drift from what was actually grouped.
exports.mergedSummary = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);

  // Each trip's calendar day depends on the timezone it happened in, not the server's/UTC — a
  // trip starting just after local midnight for a Singapore driver (UTC+8) must bucket into
  // that local day, not silently merge into the previous UTC day. Resolved from each driver's
  // stored `country` (see utils/countryTimezone.js) and looked up for every driver up front,
  // since the zone has to be known BEFORE $group buckets by day below, not after.
  const drivers = await User.find({}).select('name country');
  const driverNameMap = new Map(drivers.map((d) => [d._id.toString(), d.name]));
  const tzBranches = drivers.map((d) => ({
    case: { $eq: ['$driverId', d._id] },
    then: timezoneForCountry(d.country),
  }));

  const pipeline = [
    { $match: filter },
    {
      $addFields: {
        dateStr: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$startedAt',
            timezone: tzBranches.length ? { $switch: { branches: tzBranches, default: 'UTC' } } : 'UTC',
          },
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
        anyActive: { $max: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      },
    },
    { $sort: { firstStart: -1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        totalCount: [{ $count: 'count' }],
      },
    },
  ];

  const [facetResult] = await Trip.aggregate(pipeline);
  const results = facetResult?.rows || [];
  const total = facetResult?.totalCount?.[0]?.count || 0;

  const summaries = results.map((r) => ({
    driverId: r._id.driverId,
    driverName: driverNameMap.get(r._id.driverId.toString()) || 'Unknown',
    date: r._id.date,
    totalTrips: r.totalTrips,
    totalDistance: r.totalDistance || 0,
    maxSpeed: r.maxSpeed || 0,
    firstStart: r.firstStart,
    lastEnd: r.lastEnd,
    anyActive: Boolean(r.anyActive),
  }));

  res.json({ summaries, total, page, limit });
});

// GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=
exports.exportBulk = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);

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
