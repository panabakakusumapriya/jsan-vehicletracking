const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { canManageDriver } = require('../utils/scope');
const custody = require('../services/assetCustody');
const { releaseAllForDriver } = custody;

/**
 * Make a driver's open assets of one kind match the given id list, through the custody
 * ledger. All allocation happens on the Drivers screen — the Mobiles and Vehicles screens are
 * inventory only — so this is the single path the multi-select controls take. `assetIds`
 * being `undefined` means "field not sent, leave it alone"; `[]` means "hold none of this
 * kind". Returns per-asset problems (or null if everything went through) for the caller to
 * surface as a warning rather than failing the whole request over one bad id.
 */
async function syncAssets(user, assetKind, assetIds, actor) {
  if (assetIds === undefined) return null;
  const { errors } = await custody.syncAssignments({ driverId: user._id, assetKind, assetIds, actor });
  return errors.length ? errors : null;
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
  const { name, email, password, role = 'user', managerId } = b;
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

  // Anything picked in the Add-driver multi-selects is allocated through the ledger, so a
  // driver's very first vehicles and phones are on record from day one rather than appearing
  // out of nowhere the first time someone edits them. A driver can be given several of each.
  const assetProblems = [];
  for (const [kind, ids] of [['vehicle', b.vehicleIds], ['mobile', b.mobileDeviceIds]]) {
    const problems = await syncAssets(user, kind, ids, req.user);
    if (problems) assetProblems.push(...problems);
  }
  if (user.isModified()) await user.save();

  if (assetProblems.length) {
    // The driver exists; only some allocations failed. Say which, rather than 500-ing.
    return res.status(201).json({
      user: user.toSafeJSON(),
      warning: assetProblems.map((p) => p.error).join('; '),
    });
  }
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
  // Allocation from the Drivers screen's multi-selects. Goes through the ledger so the
  // previous holder is recorded rather than erased — see docs/asset-custody-design.md.
  // vehicleIds/mobileDeviceIds is the FULL set the driver should hold now; syncAssets diffs
  // it against what's currently open and adds/releases only what changed.
  const assetProblems = [];
  for (const [kind, ids] of [['vehicle', b.vehicleIds], ['mobile', b.mobileDeviceIds]]) {
    const problems = await syncAssets(user, kind, ids, req.user);
    if (problems) assetProblems.push(...problems);
  }
  if (b.role !== undefined && User.ROLES.includes(b.role)) user.role = b.role;
  if (b.teamLeadId !== undefined) user.teamLeadId = b.teamLeadId || null;
  if (b.managerId !== undefined) user.managerId = b.managerId || null;
  if (b.password) await user.setPassword(b.password);

  await user.save();
  if (assetProblems.length) {
    return res.json({ user: user.toSafeJSON(), warning: assetProblems.map((p) => p.error).join('; ') });
  }
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
