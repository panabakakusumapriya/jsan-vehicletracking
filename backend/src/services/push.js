const webpush = require('web-push');
const env = require('../config/env');
const User = require('../models/User');
const PushSubscription = require('../models/PushSubscription');

// A subscription that keeps failing for non-permanent reasons is dropped after this many
// consecutive attempts, so a wedged endpoint doesn't slow every future fan-out.
const MAX_FAILURES = 5;

const configured = Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
} else {
  // eslint-disable-next-line no-console
  console.warn(
    '⚠️  Web push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set.\n' +
      '   Run `npm run vapid` and put both in the environment to enable driver alerts.'
  );
}

function isConfigured() {
  return configured;
}

function publicKey() {
  return env.VAPID_PUBLIC_KEY || null;
}

/**
 * Deliver `payload` (a plain object; the service worker receives it as JSON) to every
 * subscription owned by `userIds`. Never throws — a dead phone must not break an ingest
 * or stall the watchdog loop.
 */
async function sendToUsers(userIds, payload) {
  const ids = [...new Set((userIds || []).map((id) => id.toString()))];
  if (!configured || !ids.length) return { sent: 0, failed: 0, pruned: 0 };

  const subs = await PushSubscription.find({ userId: { $in: ids } });
  if (!subs.length) return { sent: 0, failed: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  let pruned = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          body,
          // urgency:high wakes a dozing phone; TTL lets the push service hold the alert for
          // 10 min if the device is off, after which a stale "driver offline" is noise.
          { TTL: 600, urgency: 'high' }
        );
        sent += 1;
        if (sub.failureCount) {
          await PushSubscription.updateOne({ _id: sub._id }, { $set: { failureCount: 0 } });
        }
      } catch (err) {
        const status = err && err.statusCode;
        // 404/410 = the browser threw this subscription away. It is never coming back.
        if (status === 404 || status === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
          pruned += 1;
          return;
        }
        failed += 1;
        const next = (sub.failureCount || 0) + 1;
        if (next >= MAX_FAILURES) {
          await PushSubscription.deleteOne({ _id: sub._id });
          pruned += 1;
        } else {
          await PushSubscription.updateOne({ _id: sub._id }, { $set: { failureCount: next } });
        }
        // eslint-disable-next-line no-console
        console.warn(`push: send failed (${status || err.message}) for ${sub.endpoint.slice(0, 48)}…`);
      }
    })
  );

  return { sent, failed, pruned };
}

/**
 * Who should hear about this driver? The same audience the live socket fans out to:
 * the manager who owns the driver, plus every active admin.
 */
async function watcherIdsForDriver(driver) {
  const admins = await User.find({ role: 'admin', active: true }).select('_id');
  const ids = admins.map((a) => a._id.toString());
  const managerId = driver && driver.managerId;
  if (managerId) ids.push(managerId.toString());
  return [...new Set(ids)];
}

module.exports = { isConfigured, publicKey, sendToUsers, watcherIdsForDriver };
