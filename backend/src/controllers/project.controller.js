const Project = require('../models/Project');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { clearScopeCache } = require('../services/coverageScope');

// Bounds for the per-project stop timeout, mirrored by the clamp in TrackingService.kt so the
// admin form can never ask a handset for something it will silently refuse. Under 2 minutes a
// long signal would split one drive into several trips; over 30 the parked tail stops being a
// stop buffer and just inflates every trip's duration.
const TRIP_END_MIN_MINUTES = 2;
const TRIP_END_MAX_MINUTES = 30;

/**
 * Three outcomes, and they are genuinely different: the field was absent (leave the project
 * alone — a PATCH of just the name must not reset tracking), it was explicitly cleared (fall
 * back to the app default), or it carries a number to validate. Collapsing the first two is
 * what makes "I only renamed it" quietly change how trips end.
 */
function parseTripEndAfterMinutes(raw) {
  if (raw === undefined) return { skip: true };
  if (raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < TRIP_END_MIN_MINUTES || n > TRIP_END_MAX_MINUTES) {
    return {
      error: `Stop timeout must be a number between ${TRIP_END_MIN_MINUTES} and ${TRIP_END_MAX_MINUTES} minutes`,
    };
  }
  return { value: Math.round(n) };
}

// GET /api/projects?all=true  — every authenticated role can list; dropdowns need it
// everywhere (Managers, Drivers). ?all=true (admin's own Projects tab) also returns
// deactivated ones; everyone else only sees the assignable (active) set.
exports.list = asyncHandler(async (req, res) => {
  const filter = req.query.all === 'true' && req.user.role === 'admin' ? {} : { active: true };
  const projects = await Project.find(filter).sort({ name: 1 });
  res.json({ projects });
});

// POST /api/projects  (admin only)
exports.create = asyncHandler(async (req, res) => {
  const {
    name, code, country, coverageScopeId, coverageCycleId, enabledModules, showLogout,
    tripEndAfterMinutes,
  } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });

  const tripEnd = parseTripEndAfterMinutes(tripEndAfterMinutes);
  if (tripEnd.error) return res.status(400).json({ error: tripEnd.error });

  try {
    const doc = {
      name: name.trim(),
      code: code || null,
      country: country || null,
      coverageScopeId: coverageScopeId?.trim() || null,
      coverageCycleId: coverageCycleId?.trim() || null,
    };
    if (Array.isArray(enabledModules)) doc.enabledModules = enabledModules;
    if (typeof showLogout === 'boolean') doc.showLogout = showLogout;
    if (!tripEnd.skip) doc.tripEndAfterMinutes = tripEnd.value;
    const project = await Project.create(doc);
    res.status(201).json({ project });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A project with that name already exists' });
    throw err;
  }
});

// PATCH /api/projects/:id  (admin only)
exports.update = asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const {
    name, code, country, active, coverageScopeId, coverageCycleId, enabledModules, showLogout,
    tripEndAfterMinutes,
  } = req.body || {};

  const tripEnd = parseTripEndAfterMinutes(tripEndAfterMinutes);
  if (tripEnd.error) return res.status(400).json({ error: tripEnd.error });
  if (!tripEnd.skip) project.tripEndAfterMinutes = tripEnd.value;

  if (name !== undefined) project.name = name;
  if (code !== undefined) project.code = code || null;
  if (country !== undefined) project.country = country || null;
  if (active !== undefined) project.active = active;
  if (Array.isArray(enabledModules)) {
    project.enabledModules = enabledModules;
    project.markModified('enabledModules');
  }
  // Only a real boolean counts: an absent field must leave the setting alone, or any caller
  // patching just the name would reset it.
  if (typeof showLogout === 'boolean') project.showLogout = showLogout;

  // Changing the scope changes which history FUTURE trips are deduplicated against. It does not
  // rewrite the past: every trip carries the scope it was stamped with at start, so roads already
  // attributed keep their owner and numbers already reported stay reproducible. Moving existing
  // trips into a new scope is a deliberate migration, run through `npm run backfill:global-ukm`.
  const scopeChanged =
    (coverageScopeId !== undefined && (coverageScopeId?.trim() || null) !== project.coverageScopeId) ||
    (coverageCycleId !== undefined && (coverageCycleId?.trim() || null) !== project.coverageCycleId);
  if (coverageScopeId !== undefined) project.coverageScopeId = coverageScopeId?.trim() || null;
  if (coverageCycleId !== undefined) project.coverageCycleId = coverageCycleId?.trim() || null;

  try {
    await project.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A project with that name already exists' });
    throw err;
  }
  // The resolver memoises project scopes for a minute; a scope edit must take effect on the very
  // next trip, not up to a minute later.
  if (scopeChanged) clearScopeCache();
  res.json({ project });
});

// DELETE /api/projects/:id  (admin only) — blocked while anyone still references it, same
// guard MobileDevice.remove uses: history/assignment survives a rename far better than a
// dangling reference does.
exports.remove = asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const inUse = await User.countDocuments({ projectId: project._id });
  if (inUse > 0) {
    return res.status(409).json({
      error: `${inUse} user${inUse === 1 ? ' is' : 's are'} still assigned to this project. Reassign them first.`,
    });
  }
  await project.deleteOne();
  res.json({ ok: true });
});
