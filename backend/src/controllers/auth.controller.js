const crypto = require('crypto');
const User = require('../models/User');
const Trip = require('../models/Trip');
const AppActivity = require('../models/AppActivity');
const { signToken } = require('../utils/jwt');
const { isValidTimeZone } = require('../utils/timezone');
const asyncHandler = require('../utils/asyncHandler');

// A driver session is considered dead once no authed request has arrived for this long,
// which frees the account if the app was killed without logging out. The tracker pushes
// location every ~10s, so an active session stays well within this window.
const SESSION_IDLE_MS = 2 * 60 * 1000;

// POST /api/auth/login  { email, password }
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await user.verifyPassword(password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  // Single active session for drivers: reject a second concurrent login.
  if (user.role === 'user') {
    const lastSeen = user.sessionLastSeenAt ? user.sessionLastSeenAt.getTime() : 0;
    const sessionAlive = user.activeSessionId && (Date.now() - lastSeen) < SESSION_IDLE_MS;
    if (sessionAlive) {
      return res.status(409).json({
        error: 'ALREADY_LOGGED_IN',
        message: 'This account is already logged in on another device. Log out there first.',
      });
    }
    // Claim the session — this new token becomes the only valid one for this user.
    const sessionId = crypto.randomUUID();
    user.activeSessionId = sessionId;
    user.sessionLastSeenAt = new Date();
    user.lastLoginAt = new Date();
    await user.save();
    // Log sign-in activity
    AppActivity.create({
      driverId: user._id, action: 'sign_in', timestamp: new Date(),
      driverName: user.name, driverEmail: user.email,
      country: user.country, project: user.project,
    }).catch(() => {});
    return res.json({ token: signToken(user, sessionId), user: user.toSafeJSON() });
  }

  // Admins / managers may sign in from multiple places (web panel, etc.).
  user.lastLoginAt = new Date();
  await user.save();
  return res.json({ token: signToken(user), user: user.toSafeJSON() });
});

// POST /api/auth/logout — clears the active session so the driver can sign in again.
exports.logout = asyncHandler(async (req, res) => {
  if (req.user) {
    // Log sign-out activity
    if (req.user.role === 'user') {
      AppActivity.create({
        driverId: req.user._id, action: 'sign_out', timestamp: new Date(),
        driverName: req.user.name, driverEmail: req.user.email,
        country: req.user.country, project: req.user.project,
      }).catch(() => {});
    }
    req.user.activeSessionId = null;
    req.user.sessionLastSeenAt = null;
    await req.user.save();
  }
  return res.json({ ok: true });
});

// GET /api/auth/me
exports.me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

// GET /api/auth/permissions
// Returns the current user's tab permissions — used by the SSDS tool and admin panel.
// Admins always get full 'edit' on every tab. Other roles get their stored permissions
// with defaults applied for any missing keys.
exports.permissions = asyncHandler(async (req, res) => {
  const ALL_TABS = [
    'live_map', 'trips', 'drivers', 'mobiles', 'vehicles', 'weather', 'hotels',
    'couriers', 'ukm', 'app_health', 'asset_history', 'reports',
    'managers', 'projects', 'app_updates',
    'ssds_portal', 'timesheets', 'daily_status_report',
  ];
  const ADMIN_ONLY_TABS = ['managers', 'projects', 'app_updates', 'ssds_portal', 'timesheets', 'daily_status_report'];

  const stored = req.user.tabPermissions instanceof Map
    ? Object.fromEntries(req.user.tabPermissions)
    : (req.user.tabPermissions || {});

  const permissions = {};
  for (const tab of ALL_TABS) {
    if (req.user.role === 'admin') {
      permissions[tab] = 'edit';
    } else if (stored[tab]) {
      permissions[tab] = stored[tab];
    } else if (ADMIN_ONLY_TABS.includes(tab)) {
      permissions[tab] = 'hidden';
    } else {
      permissions[tab] = 'edit'; // default for non-admin tabs
    }
  }
  res.json({ permissions, role: req.user.role, userId: req.user._id });
});

// PATCH /api/auth/timezone  { timezone, country? }
// The mobile app calls this on every sign-in with the device's own IANA zone, and again
// whenever it changes — a driver who crosses into another zone re-reports without being asked.
exports.updateTimezone = asyncHandler(async (req, res) => {
  const { timezone, country } = req.body || {};
  if (!timezone) return res.status(400).json({ error: 'timezone is required' });

  // Validate before storing. A junk value here would not fail loudly — it would quietly
  // corrupt every local-day calculation downstream (weather's "today", hotel check-in dates,
  // custody month boundaries), so a bad zone is rejected rather than persisted.
  if (!isValidTimeZone(timezone)) {
    return res.status(400).json({
      error: 'INVALID_TIMEZONE',
      message: `"${timezone}" is not a recognised IANA timezone (expected something like "Asia/Kolkata").`,
    });
  }

  const changed = req.user.timezone !== timezone;
  req.user.timezone = timezone;
  if (country) req.user.country = country;
  await req.user.save();

  // A trip already running when the zone arrived would otherwise keep a null timezone for its
  // whole life, since the stamp happens at creation. Fill it in rather than lose the day.
  if (changed) {
    await Trip.updateOne(
      { driverId: req.user._id, status: 'active', timezone: null },
      { $set: { timezone } }
    );
  }

  res.json({ ok: true, timezone: req.user.timezone, country: req.user.country, user: req.user.toSafeJSON() });
});
