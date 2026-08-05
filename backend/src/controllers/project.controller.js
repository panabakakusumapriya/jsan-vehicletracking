const Project = require('../models/Project');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

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
  const { name, code, country } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name is required' });

  try {
    const project = await Project.create({
      name: name.trim(),
      code: code || null,
      country: country || null,
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

  const { name, code, country, active } = req.body || {};
  if (name !== undefined) project.name = name;
  if (code !== undefined) project.code = code || null;
  if (country !== undefined) project.country = country || null;
  if (active !== undefined) project.active = active;

  try {
    await project.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A project with that name already exists' });
    throw err;
  }
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
