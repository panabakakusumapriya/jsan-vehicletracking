const MobileDevice = require('../models/MobileDevice');
const Assignment = require('../models/Assignment');
const asyncHandler = require('../utils/asyncHandler');
const { releaseAllForDriver } = require('../services/assetCustody');

function scopeFilter(req) {
  return req.user.role === 'manager' ? { managerId: req.user._id } : {};
}

function assertCanTouch(req, device) {
  if (req.user.role === 'manager' && String(device.managerId) !== String(req.user._id)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
}

const EDITABLE = [
  'imei', 'secondaryImei', 'serial', 'label', 'phoneModel', 'androidVersion',
  'workPhone', 'phoneCase', 'phoneScreenguard', 'country', 'notes',
];

// GET /api/mobiles?status=&unassigned=true
exports.list = asyncHandler(async (req, res) => {
  const filter = { ...scopeFilter(req) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.unassigned === 'true') filter.currentDriverId = null;

  const devices = await MobileDevice.find(filter)
    .sort({ createdAt: -1 })
    .populate('currentDriverId', 'name email country')
    .populate('managerId', 'name email');

  res.json({
    devices: devices.map((d) => ({ ...d.toObject(), displayLabel: d.displayLabel() })),
  });
});

// GET /api/mobiles/:id  — the device plus its full custody history ("life story")
exports.get = asyncHandler(async (req, res) => {
  const device = await MobileDevice.findById(req.params.id).populate('currentDriverId', 'name email');
  if (!device) return res.status(404).json({ error: 'Mobile device not found' });
  assertCanTouch(req, device);

  const history = await Assignment.find({ assetKind: 'mobile', assetId: device._id })
    .sort({ startedAt: -1 })
    .populate('driverId', 'name email');

  res.json({ device: { ...device.toObject(), displayLabel: device.displayLabel() }, history });
});

// POST /api/mobiles
exports.create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.imei && !b.serial && !b.label) {
    return res.status(400).json({ error: 'Give the device an IMEI, serial or label so it can be identified' });
  }

  const doc = {};
  for (const f of EDITABLE) if (b[f] !== undefined) doc[f] = b[f] || null;
  doc.managerId = req.user.role === 'manager' ? req.user._id : b.managerId || null;
  doc.status = b.status || 'in_stock';

  try {
    const device = await MobileDevice.create(doc);
    res.status(201).json({ device });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: `A device with IMEI ${b.imei} already exists` });
    }
    throw err;
  }
});

// PATCH /api/mobiles/:id
exports.update = asyncHandler(async (req, res) => {
  const device = await MobileDevice.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Mobile device not found' });
  assertCanTouch(req, device);

  const b = req.body || {};
  for (const f of EDITABLE) if (b[f] !== undefined) device[f] = b[f] || null;
  if (b.active !== undefined) device.active = b.active;
  if (b.managerId !== undefined && req.user.role === 'admin') device.managerId = b.managerId || null;

  // Status is custody-adjacent: taking a device out of service must also hand it back,
  // otherwise a lost phone stays "held" by a driver forever.
  if (b.status !== undefined && b.status !== device.status) {
    if (!MobileDevice.STATUSES.includes(b.status)) {
      return res.status(400).json({ error: `status must be one of: ${MobileDevice.STATUSES.join(', ')}` });
    }
    const leavingService = ['lost', 'retired', 'repair'].includes(b.status);
    if (leavingService && device.currentDriverId) {
      const open = await Assignment.findOne({
        assetKind: 'mobile',
        assetId: device._id,
        endedAt: Assignment.OPEN,
      });
      if (open) {
        const { release } = require('../services/assetCustody');
        await release({ assignmentId: open._id, note: `status -> ${b.status}`, actor: req.user });
      }
    }
    device.status = b.status;
    if (leavingService) device.currentDriverId = null;
  }

  try {
    await device.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That IMEI is already registered' });
    throw err;
  }
  res.json({ device });
});

// DELETE /api/mobiles/:id — soft delete; custody history must survive.
exports.remove = asyncHandler(async (req, res) => {
  const device = await MobileDevice.findById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Mobile device not found' });
  assertCanTouch(req, device);

  if (device.currentDriverId) {
    return res.status(409).json({
      error: 'This device is still assigned to a driver. Return it first.',
    });
  }
  device.active = false;
  device.status = 'retired';
  await device.save();
  res.json({ ok: true, device });
});

// Exposed for the user controller: when a driver exits, everything comes back.
exports.releaseAllForDriver = releaseAllForDriver;
