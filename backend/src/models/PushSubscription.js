const mongoose = require('mongoose');

/**
 * One row per browser/device that opted in to alerts from the admin panel PWA.
 *
 * The `endpoint` is the push service URL the browser handed us (FCM / Mozilla / WNS).
 * It is the identity of the subscription — the same person on phone + laptop has two
 * rows, and a browser that rotates its subscription simply upserts a new one.
 *
 * Subscriptions die silently (browser uninstalled, permission revoked, endpoint expired);
 * the push service tells us with a 404/410 and the sender prunes the row. See services/push.js.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: null },
    // Refreshed every time the panel re-registers this endpoint on load.
    lastSeenAt: { type: Date, default: Date.now },
    // Consecutive send failures that were not a hard 404/410. Pruned after MAX_FAILURES.
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
