const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');

// GET /api/trips?status=&driverId=&limit=&page=
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) filter.driverId = req.query.driverId;

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
    points = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');
  }
  res.json({ trip, points });
});
