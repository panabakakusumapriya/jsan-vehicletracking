const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { canManageDriver } = require('../utils/scope');
const Assignment = require('../models/Assignment');
const custody = require('../services/assetCustody');
const { releaseAllForDriver } = custody;

/**
 * Allocate (or clear) one asset for a driver, through the custody ledger.
 *
 * All allocation happens on the Drivers screen — the Mobiles and Vehicles screens are
 * inventory only — so this is the single path both dropdowns take. Returns an error object
 * for the caller to send, or null on success. The in-memory cache field is updated too, so a
 * later user.save() in the same request cannot write the stale value back over it.
 */
async function allocate(user, assetKind, nextId, actor) {
  const cacheField = assetKind === 'vehicle' ? 'vehicleId' : 'mobileDeviceId';
  const next = nextId || null;
  const current = user[cacheField] ? String(user[cacheField]) : null;
  if (String(next || '') === (current || '')) return null;

  try {
    if (next) {
      await custody.assign({ assetKind, assetId: next, driverId: user._id, actor });
    } else {
      const open = await Assignment.findOne({ assetKind, driverId: user._id, endedAt: Assignment.OPEN });
      if (open) await custody.release({ assignmentId: open._id, actor });
    }
  } catch (err) {
    if (err instanceof custody.CustodyError) return { status: err.status, error: err.message };
    throw err;
  }
  user[cacheField] = next;
  return null;
}

// GET /api/users?role=user|manager
// admin  -> all users; manager -> only their own drivers.
exports.list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  if (req.user.role === 'manager') {
    // Manager sees all drivers assigned to them (including those delegated to team leads)
    filter.managerId = req.user._id;
    if (!req.query.role) filter.role = 'user';
  } else if (req.user.role === 'team_lead') {
    // Team lead sees only drivers specifically assigned to them
    filter.teamLeadId = req.user._id;
    filter.role = 'user';
  }
  const users = await User.find(filter)
    .sort({ createdAt: -1 })
    .populate('vehicleId', 'plateNumber model vid')
    .populate('mobileDeviceId', 'label imei phoneModel')
    .populate('teamLeadId', 'name')
    .populate('managerId', 'name');
  res.json({ users: users.map((u) => u.toSafeJSON()) });
});

// GET /api/users/:id
exports.getOne = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .populate('vehicleId', 'plateNumber model vid')
    .populate('mobileDeviceId', 'label imei phoneModel');
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
  if (req.user.role === 'manager' || req.user.role === 'team_lead') {
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
    managerId: finalRole === 'user' ? finalManager : (finalRole === 'team_lead' ? (b.managerId || null) : null),
    teamLeadId: finalRole === 'user' ? (b.teamLeadId || null) : null,
    vehicleId: null, // allocated below through the ledger, so day one is on record too
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

  // Anything picked in the Add-driver dropdowns is allocated through the ledger, so a
  // driver's very first vehicle and phone are on record from day one rather than appearing
  // out of nowhere the first time someone edits them.
  for (const [kind, id] of [['vehicle', vehicleId], ['mobile', b.mobileDeviceId]]) {
    if (!id) continue;
    const problem = await allocate(user, kind, id, req.user);
    if (problem) {
      // The driver exists; only the allocation failed. Say which, rather than 500-ing.
      return res.status(201).json({ user: user.toSafeJSON(), warning: problem.error });
    }
  }
  if (user.isModified()) await user.save();

  res.status(201).json({ user: user.toSafeJSON() });
});

// PATCH /api/users/:id
exports.update = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canManageDriver(req.user, user)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body || {};
  // Allow email updates — validate uniqueness below.
  if (b.email !== undefined && b.email !== user.email) {
    const dup = await User.findOne({ email: String(b.email).toLowerCase(), _id: { $ne: user._id } });
    if (dup) return res.status(409).json({ error: 'Email already in use' });
    user.email = String(b.email).toLowerCase();
  }

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
  if (b.exitDate !== undefined) {
    const hadNoExit = !user.exitDate;
    user.exitDate = b.exitDate || null;
    // A driver who has left cannot keep holding a truck and a phone — without this the
    // assets stay locked to them and can never be reassigned. Closing the stints here also
    // dates the return correctly in the custody history rather than "whenever someone
    // noticed". Best-effort: a failure here must not block recording the exit itself.
    if (user.exitDate && hadNoExit) {
      try {
        await releaseAllForDriver({
          driverId: user._id,
          endedAt: user.exitDate,
          note: 'driver exit',
          actor: req.user,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('exit: failed to release assets for', String(user._id), err.message);
      }
    }
  }
  if (b.pricePerHour !== undefined) user.pricePerHour = b.pricePerHour ?? null;
  if (b.perDiem !== undefined) user.perDiem = b.perDiem ?? null;
  if (b.active !== undefined) user.active = b.active;
  // Allocation from the Drivers screen. Goes through the ledger so the previous holder is
  // recorded rather than erased — see docs/asset-custody-design.md.
  if (b.vehicleId !== undefined) {
    const problem = await allocate(user, 'vehicle', b.vehicleId, req.user);
    if (problem) return res.status(problem.status).json({ error: problem.error });
  }
  if (b.mobileDeviceId !== undefined) {
    const problem = await allocate(user, 'mobile', b.mobileDeviceId, req.user);
    if (problem) return res.status(problem.status).json({ error: problem.error });
  }
  if (b.role !== undefined && User.ROLES.includes(b.role)) user.role = b.role;
  if (b.teamLeadId !== undefined) user.teamLeadId = b.teamLeadId || null;
  if (b.managerId !== undefined) user.managerId = b.managerId || null;
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
