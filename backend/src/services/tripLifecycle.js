const Trip = require('../models/Trip');
const AppActivity = require('../models/AppActivity');
const env = require('../config/env');
const { computeTripUkm } = require('./ukmCompute');

/**
 * Close active trips whose driver has genuinely gone away.
 *
 * "Gone away" used to mean only "no GPS point for SESSION_DEAD_AFTER_SECONDS", and that is not the
 * same thing. The app sends TWO independent signals: location points when the vehicle moves, and a
 * heartbeat every ~30 s saying the app itself is alive (HeartbeatSender.kt -> POST
 * /api/app-activity/heartbeat). Only the first fed this check, so a driver sitting in a tunnel, an
 * underground car park, an indoor loading bay, or anywhere GPS drops — with the app running and
 * reporting perfectly — had their trip closed as `timed_out` after 15 minutes.
 *
 * That is how ~30% of all trips ended: not because the drive finished, but because the server
 * stopped hearing points while the phone was still very much alive. Those trips then kept
 * collecting points into a closed session (see the revive path in tracking.controller.js).
 *
 * A trip is now closed only when BOTH signals are silent. `timed_out` therefore means what it
 * says: the app is gone (killed by battery optimisation, force-stopped, powered off), not merely
 * "we did not get a fix for a while".
 */

/**
 * Drivers whose app has proved itself alive within the window.
 *
 * Two sources, because neither alone is sufficient:
 *   - heartbeatCache: in-process, updated on every 30 s heartbeat. Freshest, but lost on restart
 *     and not shared between server instances.
 *   - AppActivity rows: durable, but the controller throttles writes to one per 5 minutes, so it
 *     lags. Well inside a 15-minute window, and it is what makes this correct after a deploy.
 *
 * Required in-function rather than at module load: appActivity.controller requires this module's
 * sibling services, and a top-level import would close that cycle.
 */
async function driversWithLiveApp(driverIds, since) {
  const live = new Set();
  if (!driverIds.length) return live;

  try {
    const { heartbeatCache } = require('../controllers/appActivity.controller');
    for (const id of driverIds) {
      const hb = heartbeatCache.get(String(id));
      if (hb?.time && hb.time >= since) live.add(String(id));
    }
  } catch {
    // Cache unavailable (load order, or a worker without the controller) — the DB check below
    // still covers it. Never let liveness detection throw and take the sweep down with it.
  }

  const stillUnknown = driverIds.filter((id) => !live.has(String(id)));
  if (stillUnknown.length) {
    const rows = await AppActivity.find({
      driverId: { $in: stillUnknown },
      action: 'heartbeat',
      timestamp: { $gte: since },
    }).select('driverId').lean();
    for (const r of rows) live.add(String(r.driverId));
  }

  return live;
}

async function closeDeadTrips(extraFilter = {}) {
  const deadCutoff = new Date(Date.now() - env.SESSION_DEAD_AFTER_SECONDS * 1000);
  const filter = {
    status: 'active',
    ...extraFilter,
    $or: [
      { 'lastLocation.recordedAt': { $lt: deadCutoff } },
      { lastLocation: null, startedAt: { $lt: deadCutoff } },
    ],
  };

  // Candidates: silent on GPS. Whether they are actually dead is decided below.
  const candidates = await Trip.find(filter).select('_id driverId').lean();
  if (!candidates.length) return 0;

  const liveApps = await driversWithLiveApp(
    [...new Set(candidates.map((t) => t.driverId).filter(Boolean))],
    deadCutoff
  );

  // A heartbeat inside the window means the driver is still out there with the app running; the
  // GPS silence is a coverage problem, not the end of the trip.
  const toClose = candidates.filter((t) => !liveApps.has(String(t.driverId)));
  if (!toClose.length) return 0;

  const res = await Trip.updateMany(
    { _id: { $in: toClose.map((t) => t._id) } },
    { $set: { status: 'timed_out', endedAt: new Date() } }
  );

  // Fire-and-forget UKM computation for each closed trip.
  for (const t of toClose) {
    computeTripUkm(t._id, t.driverId).catch(() => {});
  }

  return res.modifiedCount || 0;
}

module.exports = { closeDeadTrips, driversWithLiveApp };
