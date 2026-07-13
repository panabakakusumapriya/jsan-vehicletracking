const AppVersion = require('../models/AppVersion');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/app/current  — public, used by mobile app on startup
// ?platform=android|ios|web  — filters by platform (matches exact OR 'both')
exports.getCurrent = asyncHandler(async (req, res) => {
  const platform = req.query.platform || 'android';
  const version = await AppVersion.findOne({
    isActive: true,
    platform: { $in: [platform, 'both'] },
  }).sort({ releasedAt: -1 });

  if (!version) return res.json({ version: null });
  res.json({
    version: version.version,
    downloadUrl: version.downloadUrl,
    releaseNotes: version.releaseNotes,
    platform: version.platform,
  });
});

// POST /api/app/report-version  — public, called by mobile app on every startup
// Auto-creates the version record if it doesn't exist yet so admin can see it
exports.reportVersion = asyncHandler(async (req, res) => {
  const { version, platform = 'android', buildNumber } = req.body;
  if (!version) return res.status(400).json({ error: 'version is required' });

  const existing = await AppVersion.findOne({ version, platform });
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

  // Reject duplicate version+platform combo with a clear 409 instead of a 500 from MongoDB
  const existing = await AppVersion.findOne({ version, platform: platform || 'android' });
  if (existing) {
    return res.status(409).json({ error: `Version ${version} already exists for platform ${platform || 'android'}` });
  }

  // Validate downloadUrl format if provided
  if (downloadUrl) {
    try { new URL(downloadUrl); } catch {
      return res.status(400).json({ error: 'downloadUrl must be a valid URL' });
    }
  }

  // If this is set active, deactivate others for the same platform
  if (isActive) {
    await AppVersion.updateMany(
      { platform: { $in: [platform || 'android', 'both'] } },
      { isActive: false }
    );
  }

  const doc = await AppVersion.create({
    version,
    platform: platform || 'android',
    buildNumber: buildNumber ?? '',
    downloadUrl: downloadUrl || '',
    releaseNotes: releaseNotes || '',
    isActive: !!isActive,
  });
  res.status(201).json({ version: doc });
});

// PATCH /api/app/versions/:id  — admin only
exports.update = asyncHandler(async (req, res) => {
  const { isActive, downloadUrl, releaseNotes, buildNumber } = req.body;

  // Validate downloadUrl format if provided
  if (downloadUrl) {
    try { new URL(downloadUrl); } catch {
      return res.status(400).json({ error: 'downloadUrl must be a valid URL' });
    }
  }

  if (isActive) {
    // Deactivate all other versions for the same platform before activating this one
    const doc = await AppVersion.findById(req.params.id);
    if (doc) {
      await AppVersion.updateMany(
        { _id: { $ne: doc._id }, platform: { $in: [doc.platform, 'both'] } },
        { isActive: false }
      );
    }
  }

  const updated = await AppVersion.findByIdAndUpdate(
    req.params.id,
    { isActive: !!isActive, downloadUrl: downloadUrl || '', releaseNotes: releaseNotes || '', buildNumber: buildNumber ?? '' },
    { new: true, runValidators: true }
  );
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ version: updated });
});

// DELETE /api/app/versions/:id  — admin only
exports.remove = asyncHandler(async (req, res) => {
  const doc = await AppVersion.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.isActive) return res.status(400).json({ error: 'Cannot delete the active required version — deactivate it first' });
  await doc.deleteOne();
  res.json({ ok: true });
});
