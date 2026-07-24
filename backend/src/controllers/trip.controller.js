const archiver = require('archiver');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { buildKml, buildJson, baseFilename } = require('../utils/tripExport');
const { cleanRoutePoints } = require('../utils/routeClean');

// GET /api/trips?status=&driverId=&from=&to=&limit=&page=
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) filter.driverId = req.query.driverId;
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      filter.startedAt.$lte = to;
    }
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

    // Clean the route: remove duplicates, outlier spikes, and detect gaps.
    // This is defense-in-depth — the mobile tracker now filters at source,
    // but older trips in the DB may have bad points from before the fix.
    points = cleanRoutePoints(raw);
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

// GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=
exports.exportBulk = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) {
    filter.driverId = req.query.driverId;
  } else if (req.query.driverIds) {
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) filter.driverId = { $in: ids };
  }
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      filter.startedAt.$lte = to;
    }
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
