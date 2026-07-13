const AppVersion = require('../models/AppVersion');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/app/current  — public, used by mobile app on startup
exports.getCurrent = asyncHandler(async (req, res) => {
  const version = await AppVersion.findOne({ isActive: true }).sort({ releasedAt: -1 });
  if (!version) return res.json({ version: null });
  res.json({ version: version.version, downloadUrl: version.downloadUrl, releaseNotes: version.releaseNotes });
});

// POST /api/app/report-version  — public, called by mobile app on every startup
// Auto-creates the version record if it doesn't exist yet so admin can see it
exports.reportVersion = asyncHandler(async (req, res) => {
  const { version, platform = 'android', buildNumber } = req.body;
  if (!version) return res.status(400).json({ error: 'version is required' });

  const existing = await AppVersion.findOne({ version });
  if (!existing) {
    await AppVersion.create({
      version,
      platform,
      buildNumber: buildNumber ?? '',
      downloadUrl: '',
      releaseNotes: '',
      isActive: false, // admin must explicitly set active
    });
  }
  res.json({ ok: true });
});


// GET /api/app/versions  — admin only
exports.list = asyncHandler(async (req, res) => {
  const versions = await AppVersion.find().sort({ releasedAt: -1 });
  res.json({ versions });
});

// POST /api/app/versions  — admin only
exports.create = asyncHandler(async (req, res) => {
  const { version, platform, buildNumber, downloadUrl, releaseNotes, isActive } = req.body;
  if (!version) return res.status(400).json({ error: 'version is required' });

  // If this is set active, deactivate others
  if (isActive) await AppVersion.updateMany({}, { isActive: false });

  const doc = await AppVersion.create({ version, platform, buildNumber: buildNumber ?? '', downloadUrl, releaseNotes, isActive: !!isActive });
  res.status(201).json({ version: doc });
});

// PATCH /api/app/versions/:id  — admin only
exports.update = asyncHandler(async (req, res) => {
  const { isActive, downloadUrl, releaseNotes, buildNumber } = req.body;

  if (isActive) await AppVersion.updateMany({}, { isActive: false });

  const doc = await AppVersion.findByIdAndUpdate(
    req.params.id,
    { isActive: !!isActive, downloadUrl, releaseNotes, buildNumber: buildNumber ?? '' },
    { new: true, runValidators: true }
  );
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ version: doc });
});

// DELETE /api/app/versions/:id  — admin only
exports.remove = asyncHandler(async (req, res) => {
  const doc = await AppVersion.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});
