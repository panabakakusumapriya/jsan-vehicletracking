const asyncHandler = require('../utils/asyncHandler');
const PushSubscription = require('../models/PushSubscription');
const { isConfigured, publicKey, sendToUsers } = require('../services/push');
const env = require('../config/env');

/**
 * GET /api/push/public-key   (no auth)
 * The VAPID public key is, by definition, public — the browser needs it before it can
 * create a subscription, and the panel asks for it on the login screen too.
 */
exports.getPublicKey = asyncHandler(async (req, res) => {
  res.json({
    publicKey: publicKey(),
    configured: isConfigured(),
    alertsEnabled: env.ALERTS_ENABLED,
  });
});

/**
 * POST /api/push/subscribe   (admin / manager)
 * Body: { endpoint, keys: { p256dh, auth }, userAgent? }
 *
 * Idempotent by endpoint: the panel calls this on every load while permission is granted,
 * which is also how a rotated subscription re-binds itself to the right user.
 */
exports.subscribe = asyncHandler(async (req, res) => {
  const { endpoint, keys, userAgent } = req.body || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'endpoint and keys{p256dh,auth} are required' });
  }

  const sub = await PushSubscription.findOneAndUpdate(
    { endpoint },
    {
      $set: {
        userId: req.user._id,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: (userAgent || req.headers['user-agent'] || '').slice(0, 300) || null,
        lastSeenAt: new Date(),
        failureCount: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({ ok: true, id: sub._id, pushConfigured: isConfigured() });
});

/**
 * POST /api/push/unsubscribe   (admin / manager)
 * Body: { endpoint }. Scoped to the caller so one user can't unhook another's device.
 */
exports.unsubscribe = asyncHandler(async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  const { deletedCount } = await PushSubscription.deleteOne({ endpoint, userId: req.user._id });
  res.json({ ok: true, removed: deletedCount });
});

/**
 * POST /api/push/test   (admin / manager)
 * Fires a notification at the caller's own devices — the "did I actually wire this up?" check.
 */
exports.test = asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Push is not configured on the server (missing VAPID keys)' });
  }
  const result = await sendToUsers([req.user._id], {
    type: 'test',
    title: 'JSAN Fleet alerts are on',
    body: `You'll get a notification here when a driver stops reporting for ${Math.round(
      env.DRIVER_OFFLINE_AFTER_SECONDS / 60
    )} min.`,
    tag: 'jsan-test',
    url: '/',
    ts: new Date().toISOString(),
  });
  if (!result.sent) {
    return res.status(404).json({ error: 'No live subscriptions for this account', ...result });
  }
  res.json({ ok: true, ...result });
});
