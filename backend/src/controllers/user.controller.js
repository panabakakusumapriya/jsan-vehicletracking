const User = require('../models/User');
const Project = require('../models/Project');
const asyncHandler = require('../utils/asyncHandler');
const { canManageDriver, linkedOrOnProjects } = require('../utils/scope');
const custody = require('../services/assetCustody');
const { releaseAllForDriver } = custody;

/**
 * Which project(s) a new user lands in, and whether that's even optional for their role.
 *
 * A driver always holds exactly one project. A manager or team lead can hold several — real
 * fleets have one manager running more than one project at once (129 drivers split across 3
 * projects under a single manager, observed directly in this fleet's data), so a single
 * project isn't enough for that tier. Admins pick freely, from either shape. Managers and team
 * leads only ever create drivers (`create` below forces finalRole to 'user' for them), and
 * that driver always lands inside ONE of the creator's OWN projects — never one outside it —
 * so "role management is project-scoped" holds structurally, not by convention.
 */
async function resolveProjectsForCreate(req, b, finalRole) {
  const requiresProject = ['manager', 'team_lead', 'user'].includes(finalRole);
  const multi = finalRole === 'manager' || finalRole === 'team_lead';

  if (req.user.role !== 'admin') {
    const own = (req.user.projectIds || []).map(String);
    if (!own.length) {
      return { error: 'Your account has no project assigned — ask an admin to fix that before adding drivers.' };
    }
    const requested = b.projectId ? String(b.projectId) : null;
    const chosen = requested && own.includes(requested) ? requested : own[0];
    const project = await Project.findById(chosen);
    if (!project) return { error: 'Your assigned project no longer exists' };
    return { projectIds: [project._id], projectNames: [project.name] };
  }

  const raw = multi
    ? (Array.isArray(b.projectIds) ? b.projectIds.filter(Boolean) : [])
    : (b.projectId ? [b.projectId] : []);
  if (!raw.length) {
    return requiresProject ? { error: 'Project is required' } : { projectIds: [], projectNames: [] };
  }
  const projects = await Project.find({ _id: { $in: raw }, active: true });
  if (projects.length !== raw.length) return { error: 'One or more selected projects were not found or are inactive' };
  return { projectIds: projects.map((p) => p._id), projectNames: projects.map((p) => p.name) };
}

/**
 * Only touches project(s) when the request actually sends the relevant field
 * (`projectId` for a driver target, `projectIds` for a manager/team_lead target) — legacy
 * accounts predating this field must stay editable without being force-migrated on their next
 * unrelated edit. Same "own project(s) only" rule as create for non-admins.
 */
async function resolveProjectsForUpdate(req, b, targetRole) {
  const multi = targetRole === 'manager' || targetRole === 'team_lead';
  const touched = multi ? b.projectIds !== undefined : b.projectId !== undefined;
  if (!touched) return null;

  if (req.user.role !== 'admin') {
    const own = (req.user.projectIds || []).map(String);
    if (!own.length) return { projectIds: [], projectNames: [] };
    const requested = b.projectId ? String(b.projectId) : null;
    const chosen = requested && own.includes(requested) ? requested : own[0];
    const project = await Project.findById(chosen);
    return project ? { projectIds: [project._id], projectNames: [project.name] } : { projectIds: [], projectNames: [] };
  }

  const raw = multi
    ? (Array.isArray(b.projectIds) ? b.projectIds.filter(Boolean) : [])
    : (b.projectId ? [b.projectId] : []);
  if (!raw.length) return { projectIds: [], projectNames: [] };
  const projects = await Project.find({ _id: { $in: raw }, active: true });
  if (projects.length !== raw.length) return { error: 'One or more selected projects were not found or are inactive' };
  return { projectIds: projects.map((p) => p._id), projectNames: projects.map((p) => p.name) };
}

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

// GET /api/users?role=user|manager&projectId=<id>
// admin  -> all users; manager -> only their own drivers.
exports.list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.role) filter.role = req.query.role;
  /**
   * Scope to one project. `projectIds` is an array, and Mongo matches a scalar against an array
   * by containment, so this reads as "is on this project".
   *
   * Added because callers were already passing ?projectId= and silently getting the WHOLE fleet:
   * the work-area assignment picker offered every driver in the company, including other
   * customers' crews, for a project they had nothing to do with.
   */
  if (/^[a-f\d]{24}$/i.test(String(req.query.projectId || ''))) {
    filter.projectIds = req.query.projectId;
  }
  if (req.user.role === 'manager' || req.user.role === 'team_lead') {
    const linkField = req.user.role === 'manager' ? 'managerId' : 'teamLeadId';
    if ((req.query.role || 'user') === 'user') {
      // Drivers: explicitly linked OR on any of the requester's projects — same rule as
      // accessibleDriverFilter. Project assignment alone must be enough to see a fleet;
      // an account created "runs project X" has no per-driver links pointing back at it.
      filter.role = 'user';
      filter.$or = linkedOrOnProjects(req.user, linkField).$or;
    } else {
      // Listing other managers/team_leads stays scoped to explicit links.
      filter[linkField] = req.user._id;
    }
  }
  const users = await User.find(filter)
    .sort({ createdAt: -1 })
    .populate('vehicleId', 'plateNumber model vid')
    .populate('mobileDeviceId', 'label imei phoneModel')
    .populate('teamLeadId', 'name')
    .populate('managerId', 'name')
    .populate('projectIds', 'name code country');
  res.json({ users: users.map((u) => u.toSafeJSON()) });
});

// GET /api/users/:id
exports.getOne = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
    .populate('vehicleId', 'plateNumber model vid')
    .populate('mobileDeviceId', 'label imei phoneModel')
    .populate('projectIds', 'name code country');
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

  const projectResolved = await resolveProjectsForCreate(req, b, finalRole);
  if (projectResolved.error) return res.status(400).json({ error: projectResolved.error });

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
    projectIds: projectResolved.projectIds,
    driverId: b.driverId || null,
    project: projectResolved.projectNames.join(', ') || null,
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
    'name', 'phone', 'country', 'timezone', 'driverId', 'scope', 'region',
    'drivingLocation', 'driverMode', 'poc', 'contact', 'personalMail',
    'driverAddress', 'ctsMail', 'driverStatus', 'currency', 'language',
    'workPhone', 'imei', 'phoneModel', 'androidVersion', 'phoneCase', 'phoneScreenguard',
  ];
  for (const f of strFields) {
    if (b[f] !== undefined) user[f] = b[f] || null;
  }
  // project/projectIds move together — see resolveProjectsForUpdate. `project` (the display
  // string) is no longer directly settable; it's always derived from the Project docs.
  const projectResolved = await resolveProjectsForUpdate(req, b, user.role);
  if (projectResolved?.error) return res.status(400).json({ error: projectResolved.error });
  if (projectResolved) {
    user.projectIds = projectResolved.projectIds;
    user.project = projectResolved.projectNames.join(', ') || null;
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
  // Deactivating used to set `active` and nothing else, which left two things quietly wrong:
  // `driverStatus` still read "Active" in every report, and — worse — no `exitDate` meant the
  // asset release in update() never fired, so the driver kept holding their vehicle and phone and
  // neither could be reassigned to anyone. 15 drivers were found in exactly that state.
  const wasActive = user.active;
  user.active = false;
  if (user.role === 'user') {
    user.driverStatus = 'Exit';
    if (!user.exitDate) user.exitDate = new Date();
  }
  await user.save();

  // Best-effort, mirroring update(): recording the exit must not fail because a custody stint
  // could not be closed. Only on the transition, so a repeated call cannot re-date the history.
  if (wasActive && user.role === 'user') {
    try {
      await releaseAllForDriver({
        driverId: user._id,
        endedAt: user.exitDate,
        note: 'driver exit',
        actor: req.user,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`exit: failed to release assets for ${user._id}:`, err.message);
    }
  }

  res.json({ ok: true });
});
