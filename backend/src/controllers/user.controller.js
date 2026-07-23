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
  const { name, email, password, phone, role = 'user', managerId, vehicleId, country } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }

  let finalRole = role;
  let finalManager = managerId || null;
  if (req.user.role === 'manager') {
    finalRole = 'user'; // managers can only create drivers, always under themselves
    finalManager = req.user._id;
  }
  if (!User.ROLES.includes(finalRole)) return res.status(400).json({ error: 'invalid role' });

  const exists = await User.findOne({ email: String(email).toLowerCase() });
  if (exists) return res.status(409).json({ error: 'email already in use' });

  const user = new User({
    name,
    email,
    phone: phone || null,
    country: country || null,
    role: finalRole,
    managerId: finalRole === 'user' ? finalManager : null,
    vehicleId: vehicleId || null,
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

  const { name, phone, active, vehicleId, managerId, password, role, country } = req.body || {};
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (country !== undefined) user.country = country || null;
  if (active !== undefined) user.active = active;
  if (vehicleId !== undefined) {
    user.vehicleId = vehicleId || null;
    if (vehicleId) await Vehicle.findByIdAndUpdate(vehicleId, { assignedDriverId: user._id });
  }
  // Only admins may change role / reassign manager.
  if (req.user.role === 'admin') {
    if (role !== undefined && User.ROLES.includes(role)) user.role = role;
    if (managerId !== undefined) user.managerId = managerId || null;
  }
  if (password) await user.setPassword(password);

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
