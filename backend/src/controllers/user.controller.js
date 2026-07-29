const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const asyncHandler = require('../utils/asyncHandler');
const { canManageDriver } = require('../utils/scope');

// GET /api/users?role=user|manager
// admin  -> all users; manager -> only their own drivers.
exports.list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.user.role === 'manager') {
    filter.managerId = req.user._id;
    filter.role = 'user';
  }
  const users = await User.find(filter).sort({ createdAt: -1 }).populate('vehicleId', 'plateNumber model');
  res.json({ users: users.map((u) => u.toSafeJSON()) });
});

// GET /api/users/:id
exports.getOne = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).populate('vehicleId', 'plateNumber model');
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canManageDriver(req.user, user)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ user: user.toSafeJSON() });
});

// POST /api/users  (admin creates admin/manager/driver; manager creates drivers only)
exports.create = asyncHandler(async (req, res) => {
  const b = req.body || {};
  const { name, email, password, role = 'user', managerId, vehicleId } = b;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }

  let finalRole = role;
  let finalManager = managerId || null;
  if (req.user.role === 'manager') {
    finalRole = 'user';
    finalManager = req.user._id;
  }
  if (!User.ROLES.includes(finalRole)) return res.status(400).json({ error: 'invalid role' });

  const exists = await User.findOne({ email: String(email).toLowerCase() });
  if (exists) return res.status(409).json({ error: 'email already in use' });

  const user = new User({
    name,
    email,
    phone: b.phone || null,
    country: b.country || null,
    timezone: b.timezone || null,
    role: finalRole,
    managerId: finalRole === 'user' ? finalManager : null,
    vehicleId: vehicleId || null,
    driverId: b.driverId || null,
    project: b.project || null,
    scope: b.scope || null,
    region: b.region || null,
    drivingLocation: b.drivingLocation || null,
    driverMode: b.driverMode || null,
    poc: b.poc || null,
    contact: b.contact || null,
    personalMail: b.personalMail || null,
    driverAddress: b.driverAddress || null,
    ctsMail: b.ctsMail || null,
    driverStatus: b.driverStatus || null,
    joiningDate: b.joiningDate || null,
    exitDate: b.exitDate || null,
    pricePerHour: b.pricePerHour ?? null,
    perDiem: b.perDiem ?? null,
    currency: b.currency || null,
    language: b.language || null,
    workPhone: b.workPhone || null,
    imei: b.imei || null,
    phoneModel: b.phoneModel || null,
    androidVersion: b.androidVersion || null,
    phoneCase: b.phoneCase || null,
    phoneScreenguard: b.phoneScreenguard || null,
  });
  await user.setPassword(password);
  await user.save();

  // Keep the vehicle's assignedDriverId in sync.
  if (vehicleId) await Vehicle.findByIdAndUpdate(vehicleId, { assignedDriverId: user._id });

  res.status(201).json({ user: user.toSafeJSON() });
});

// PATCH /api/users/:id
exports.update = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canManageDriver(req.user, user)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body || {};
  const strFields = [
    'name', 'phone', 'country', 'timezone', 'driverId', 'project', 'scope', 'region',
    'drivingLocation', 'driverMode', 'poc', 'contact', 'personalMail',
    'driverAddress', 'ctsMail', 'driverStatus', 'currency', 'language',
    'workPhone', 'imei', 'phoneModel', 'androidVersion', 'phoneCase', 'phoneScreenguard',
  ];
  for (const f of strFields) {
    if (b[f] !== undefined) user[f] = b[f] || null;
  }
  if (b.joiningDate !== undefined) user.joiningDate = b.joiningDate || null;
  if (b.exitDate !== undefined) user.exitDate = b.exitDate || null;
  if (b.pricePerHour !== undefined) user.pricePerHour = b.pricePerHour ?? null;
  if (b.perDiem !== undefined) user.perDiem = b.perDiem ?? null;
  if (b.active !== undefined) user.active = b.active;
  if (b.vehicleId !== undefined) {
    user.vehicleId = b.vehicleId || null;
    if (b.vehicleId) await Vehicle.findByIdAndUpdate(b.vehicleId, { assignedDriverId: user._id });
  }
  if (req.user.role === 'admin') {
    if (b.role !== undefined && User.ROLES.includes(b.role)) user.role = b.role;
    if (b.managerId !== undefined) user.managerId = b.managerId || null;
  }
  if (b.password) await user.setPassword(b.password);

  await user.save();
  res.json({ user: user.toSafeJSON() });
});

// DELETE /api/users/:id  (soft delete: mark inactive)
exports.remove = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canManageDriver(req.user, user)) return res.status(403).json({ error: 'Forbidden' });
  user.active = false;
  await user.save();
  res.json({ ok: true });
});
