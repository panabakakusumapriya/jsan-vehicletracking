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

  for (const d of drivers) {
    const lastSignIn = await AppActivity.findOne({ driverId: d._id, action: 'sign_in' })
      .sort({ timestamp: -1 }).lean();
    const lastSignOut = await AppActivity.findOne({ driverId: d._id, action: 'sign_out' })
      .sort({ timestamp: -1 }).lean();

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

  res.json({ ok: true });
});

// No auto sign-out watchdog. A driver losing internet while driving would
// create false sign_out → sign_in pairs. The heartbeat cache is used only
// for the dashboard's online/offline indicator. Real sign_out events come
// exclusively from POST /api/auth/logout (called by the app).

// Expose for testing
exports.STALE_MS = STALE_MS;
exports.heartbeatCache = heartbeatCache;
