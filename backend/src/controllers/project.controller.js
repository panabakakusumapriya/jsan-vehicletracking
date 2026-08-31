const Project = require('../models/Project');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { clearScopeCache } = require('../services/coverageScope');

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
  const { name, code, country, coverageScopeId, coverageCycleId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });

  try {
    const project = await Project.create({
      name: name.trim(),
      code: code || null,
      country: country || null,
      // Which dedup universe this project's roads belong to. Left null on purpose when not given:
      // null resolves to the fleet-wide default scope, so a new project deduplicates against
      // everything else, which is the required behaviour. Setting a distinct scope is what CREATES
      // billable duplicate coverage, so it has to be asked for. See services/coverageScope.js.
      coverageScopeId: coverageScopeId?.trim() || null,
      coverageCycleId: coverageCycleId?.trim() || null,
    });
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

  const { name, code, country, active, coverageScopeId, coverageCycleId } = req.body || {};
  if (name !== undefined) project.name = name;
  if (code !== undefined) project.code = code || null;
  if (country !== undefined) project.country = country || null;
  if (active !== undefined) project.active = active;

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
