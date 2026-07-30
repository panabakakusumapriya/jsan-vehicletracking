const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Assignment = require('../models/Assignment');
const asyncHandler = require('../utils/asyncHandler');
const custody = require('../services/assetCustody');

/**
 * Move a vehicle between drivers through the custody ledger rather than by overwriting
 * `assignedDriverId`. Same visible outcome, except the previous holder is now recorded
 * instead of erased. Returns an error response body if the change is illegal, else null.
 */
async function applyDriverChange(vehicle, nextDriverId, actor) {
  const current = vehicle.assignedDriverId ? String(vehicle.assignedDriverId) : null;
  const next = nextDriverId ? String(nextDriverId) : null;
  if (next === current) return null;

  try {
    if (next) {
      await custody.assign({ assetKind: 'vehicle', assetId: vehicle._id, driverId: next, actor });
    } else {
      const open = await Assignment.findOne({
        assetKind: 'vehicle', assetId: vehicle._id, endedAt: Assignment.OPEN,
      });
      if (open) await custody.release({ assignmentId: open._id, actor });
    }
  } catch (err) {
    if (err instanceof custody.CustodyError) return { status: err.status, error: err.message };
    throw err;
  }
  vehicle.assignedDriverId = next;
  return null;
}

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
  const { plateNumber, vid, model, managerId, assignedDriverId } = req.body || {};
  if (!plateNumber) return res.status(400).json({ error: 'plateNumber is required' });

  const vehicle = await Vehicle.create({
    plateNumber,
    vid: vid || null,
    model: model || null,
    managerId: req.user.role === 'manager' ? req.user._id : managerId || null,
    assignedDriverId: null, // set below, via the ledger
  });
  if (assignedDriverId) {
    const problem = await applyDriverChange(vehicle, assignedDriverId, req.user);
    if (problem) return res.status(problem.status).json({ error: problem.error });
    await vehicle.save();
  }

  res.status(201).json({ vehicle });
});

// PATCH /api/vehicles/:id
exports.update = asyncHandler(async (req, res) => {
  const vehicle = await Vehicle.findById(req.params.id);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
  if (req.user.role === 'manager' && String(vehicle.managerId) !== String(req.user._id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { plateNumber, vid, model, active, assignedDriverId } = req.body || {};
  if (plateNumber !== undefined) vehicle.plateNumber = plateNumber;
  if (vid !== undefined) vehicle.vid = vid;
  if (model !== undefined) vehicle.model = model;
  if (active !== undefined) vehicle.active = active;
  if (assignedDriverId !== undefined) {
    const problem = await applyDriverChange(vehicle, assignedDriverId, req.user);
    if (problem) return res.status(problem.status).json({ error: problem.error });
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
