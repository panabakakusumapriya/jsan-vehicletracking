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
      buildNumber: buildNumber ? Number(buildNumber) : undefined,
      downloadUrl: '',
      releaseNotes: '',
      isActive: false, // admin must explicitly set active
    });
  }
  res.json({ ok: true });
});

// POST /api/app/eas-webhook  — called by EAS after each successful build
// Auto-updates (or creates) the version with the real download URL
exports.easWebhook = asyncHandler(async (req, res) => {
  const secret = process.env.EAS_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['expo-signature'] || '';
    if (!sig.includes(secret)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }

  const { status, metadata, artifacts } = req.body;
  if (status !== 'finished') return res.json({ ok: true, skipped: true });

  const version = metadata?.appVersion;
  const downloadUrl = artifacts?.buildUrl || '';
  const platform = metadata?.platform || 'android';
  const buildNumber = metadata?.buildNumber ? Number(metadata.buildNumber) : undefined;

  if (!version) return res.status(400).json({ error: 'No appVersion in metadata' });

  await AppVersion.findOneAndUpdate(
    { version },
    { $setOnInsert: { isActive: false, releaseNotes: '' }, $set: { downloadUrl, platform, buildNumber } },
    { upsert: true, new: true }
  );

  res.json({ ok: true, version, downloadUrl });
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

  const doc = await AppVersion.create({ version, platform, buildNumber, downloadUrl, releaseNotes, isActive: !!isActive });
  res.status(201).json({ version: doc });
});

// PATCH /api/app/versions/:id  — admin only
exports.update = asyncHandler(async (req, res) => {
  const { isActive, downloadUrl, releaseNotes, buildNumber } = req.body;

  if (isActive) await AppVersion.updateMany({}, { isActive: false });

  const doc = await AppVersion.findByIdAndUpdate(
    req.params.id,
    { isActive: !!isActive, downloadUrl, releaseNotes, buildNumber },
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
