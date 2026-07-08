const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

function scopeFilter(req) {
  return req.user.role === 'manager' ? { managerId: req.user._id } : {};
}

// GET /api/vehicles
exports.list = asyncHandler(async (req, res) => {
  const vehicles = await Vehicle.find(scopeFilter(req))
    .sort({ createdAt: -1 })
    .populate('assignedDriverId', 'name email');
  res.json({ vehicles });
});

// POST /api/vehicles
exports.create = asyncHandler(async (req, res) => {
  const { plateNumber, model, managerId, assignedDriverId } = req.body || {};
  if (!plateNumber) return res.status(400).json({ error: 'plateNumber is required' });

  const vehicle = await Vehicle.create({
    plateNumber,
    model: model || null,
    managerId: req.user.role === 'manager' ? req.user._id : managerId || null,
    assignedDriverId: assignedDriverId || null,
  });
  if (assignedDriverId) await User.findByIdAndUpdate(assignedDriverId, { vehicleId: vehicle._id });

  res.status(201).json({ vehicle });
});

// PATCH /api/vehicles/:id
exports.update = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (req.user.role === 'manager' && String(vehicle.managerId) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { plateNumber, model, active, assignedDriverId } = req.body || {};
  if (plateNumber !== undefined) vehicle.plateNumber = plateNumber;
  if (model !== undefined) vehicle.model = model;
  if (active !== undefined) vehicle.active = active;
  if (assignedDriverId !== undefined) {
    vehicle.assignedDriverId = assignedDriverId || null;
    if (assignedDriverId) await User.findByIdAndUpdate(assignedDriverId, { vehicleId: vehicle._id });
  }
  await vehicle.save();
  res.json({ vehicle });
});

// DELETE /api/vehicles/:id
exports.remove = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (req.user.role === 'manager' && String(vehicle.managerId) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await vehicle.deleteOne();
  res.json({ ok: true });
});
