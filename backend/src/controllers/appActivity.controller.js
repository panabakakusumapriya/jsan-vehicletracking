const AppActivity = require('../models/AppActivity');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');

// How long without a heartbeat before the dashboard shows "Offline" (ms).
// This is DISPLAY ONLY — no sign_out event is logged. The driver may just
// be in a dead zone while driving. Real sign_out only comes from the app
// calling POST /api/auth/logout.
const STALE_MS = 5 * 60 * 1000; // 5 minutes

// In-memory map of driverId -> { time: Date, gpsOn, networkOn, batteryRestricted, batteryLevel }
const heartbeatCache = new Map();

// ── Admin: list activities + driver summary ──────────────────────────────────

// GET /api/app-activity?driverId=&from=&to=
exports.list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.driverId) filter.driverId = req.query.driverId;
  if (req.query.from || req.query.to) {
    filter.timestamp = {};
    if (req.query.from) filter.timestamp.$gte = new Date(req.query.from);
    if (req.query.to) filter.timestamp.$lte = new Date(req.query.to);
  }

  // Only show sign_in / sign_out in the history (not heartbeat noise)
  filter.action = { $in: ['sign_in', 'sign_out'] };

  const activities = await AppActivity.find(filter)
    .sort({ timestamp: -1 })
    .limit(500)
    .populate('driverId', 'name email country project');

  // Build a summary: last sign-in / sign-out per driver + online status via heartbeat
  const drivers = await User.find({ role: 'user', active: true }).select('name email country project').lean();
  const summaryList = [];

  // Newest sign_in and sign_out for every driver in ONE aggregation. This was two findOne calls
  // per driver — 320 sequential round trips for 160 drivers, all to build one summary table.
  // The $sort is {driverId, timestamp:-1} specifically so the existing compound index provides
  // the order; $first then picks the newest row within each (driver, action) group.
  const latestByDriverAction = new Map();
  if (drivers.length) {
    const rows = await AppActivity.aggregate([
      { $match: { driverId: { $in: drivers.map((d) => d._id) }, action: { $in: ['sign_in', 'sign_out'] } } },
      { $sort: { driverId: 1, timestamp: -1 } },
      { $group: { _id: { driverId: '$driverId', action: '$action' }, timestamp: { $first: '$timestamp' } } },
    ]);
    for (const r of rows) {
      latestByDriverAction.set(`${r._id.driverId}|${r._id.action}`, { timestamp: r.timestamp });
    }
  }

  for (const d of drivers) {
    const lastSignIn = latestByDriverAction.get(`${d._id}|sign_in`) || null;
    const lastSignOut = latestByDriverAction.get(`${d._id}|sign_out`) || null;

    const hb = heartbeatCache.get(String(d._id));
    const lastHb = hb?.time || null;
    const isRecent = lastHb && (Date.now() - lastHb.getTime()) < STALE_MS;

    // Determine granular status
    let status = 'offline';
    if (!lastSignIn || (lastSignOut && lastSignOut.timestamp > lastSignIn.timestamp)) {
      status = 'logged_out';
    } else if (!isRecent) {
      status = 'app_closed';
    } else if (hb && !hb.gpsOn) {
      status = 'gps_off';
    } else if (hb && !hb.networkOn) {
      status = 'network_off';
    } else if (hb && hb.batteryRestricted) {
      status = 'battery_restricted';
    } else if (isRecent) {
      status = 'online';
    }

    summaryList.push({
      driver: d,
      lastSignIn: lastSignIn?.timestamp || null,
      lastSignOut: lastSignOut?.timestamp || null,
      lastHeartbeat: lastHb || null,
      online: status === 'online',
      status,
      batteryLevel: hb?.batteryLevel ?? null,
    });
  }

  res.json({
    activities: activities.map(a => ({
      ...a.toObject(),
      driverName: a.driverId && typeof a.driverId === 'object' ? a.driverId.name : a.driverName,
      driverEmail: a.driverId && typeof a.driverId === 'object' ? a.driverId.email : a.driverEmail,
    })),
    summary: summaryList,
  });
});

// ── Driver: heartbeat ────────────────────────────────────────────────────────

// POST /api/app-activity/heartbeat
// Called by the Kotlin app every 30-60s. Lightweight — only updates in-memory cache
// and writes a DB row every 5 minutes to avoid flooding the collection.
const HEARTBEAT_DB_INTERVAL_MS = 5 * 60 * 1000;
const lastDbWrite = new Map(); // driverId -> last DB write timestamp

/**
 * Per-project tracking settings ride back on the heartbeat RESPONSE.
 *
 * The tracking engine is a foreground service that runs for a whole shift without anyone
 * opening the app, so a setting delivered only through /me — which the app re-reads on
 * foreground — could sit unapplied until the driver next looked at their phone. The service
 * already calls this endpoint every ~30 s, so an admin's change reaches the handset within
 * about two minutes with no driver interaction at all. /me still carries it too: that is the
 * path that survives a service restart before the first heartbeat goes out.
 *
 * Memoised because this runs once per heartbeat per driver. Without the cache a 50-handset
 * fleet would add ~100 project reads a minute to fetch a field that changes once a month.
 */
const PROJECT_SETTINGS_TTL_MS = 60 * 1000;
const projectSettingsCache = new Map(); // projectId -> { at, settings }

async function projectTrackingSettings(user) {
  const pid = user.projectIds?.[0];
  if (!pid) return {};

  const key = String(pid);
  const hit = projectSettingsCache.get(key);
  if (hit && Date.now() - hit.at < PROJECT_SETTINGS_TTL_MS) return hit.settings;

  const Project = require('../models/Project');
  const project = await Project.findById(pid).select('tripEndAfterMinutes').lean();
  // `.lean()` does not apply schema defaults, so a project saved before this field existed
  // reads undefined. Undefined has to mean "use the app's own default" — sending 0 or null as
  // a number would tell the handset to end trips instantly.
  const settings =
    typeof project?.tripEndAfterMinutes === 'number'
      ? { tripEndAfterMinutes: project.tripEndAfterMinutes }
      : {};
  projectSettingsCache.set(key, { at: Date.now(), settings });
  return settings;
}

exports.heartbeat = asyncHandler(async (req, res) => {
  const user = req.user;
  const now = new Date();
  const id = String(user._id);

  const { gpsOn, networkOn, batteryRestricted, batteryLevel } = req.body || {};
  heartbeatCache.set(id, {
    time: now,
    gpsOn: gpsOn !== false,
    networkOn: networkOn !== false,
    batteryRestricted: batteryRestricted === true,
    batteryLevel: typeof batteryLevel === 'number' ? batteryLevel : null,
  });

  // Write to DB at most once every 5 minutes
  const lastWrite = lastDbWrite.get(id) || 0;
  if (now.getTime() - lastWrite > HEARTBEAT_DB_INTERVAL_MS) {
    lastDbWrite.set(id, now.getTime());
    AppActivity.create({
      driverId: user._id, action: 'heartbeat', timestamp: now,
      driverName: user.name, driverEmail: user.email,
      country: user.country, project: user.project,
    }).catch(() => {});
  }

  // Config delivery must never be able to break liveness reporting: if the project lookup
  // fails, the heartbeat still answers ok and the handset simply keeps the setting it has.
  let settings = {};
  try {
    settings = await projectTrackingSettings(user);
  } catch {
    /* fall through with no settings */
  }

  res.json({ ok: true, ...settings });
});

// No auto sign-out watchdog. A driver losing internet while driving would
// create false sign_out → sign_in pairs. The heartbeat cache is used only
// for the dashboard's online/offline indicator. Real sign_out events come
// exclusively from POST /api/auth/logout (called by the app).

// Expose for testing
exports.STALE_MS = STALE_MS;
exports.heartbeatCache = heartbeatCache;
