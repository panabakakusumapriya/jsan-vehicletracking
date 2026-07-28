require('dotenv').config();

const required = ['MONGODB_URI', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(
    `\n❌ Missing required environment variables: ${missing.join(', ')}\n` +
      '   Copy backend/.env.example to backend/.env and fill in the values.\n'
  );
  process.exit(1);
}

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  // '*' must stay a bare string (wildcard). A comma list becomes an array of exact
  // origins. NOTE: `['*']` is NOT a wildcard in the cors package — it's an exact match.
  CORS_ORIGIN: parseCorsOrigin(process.env.CORS_ORIGIN),
  HEARTBEAT_INTERVAL_SECONDS: parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '10', 10),
  STALE_AFTER_SECONDS: parseInt(process.env.STALE_AFTER_SECONDS || '60', 10),
  // An active trip silent longer than this is treated as dead (app killed / long signal
  // loss / crashed test session) and auto-closed so it stops lingering on the live map.
  // Kept well above the device's 10s heartbeat and normal GPS blips. Default 15 min.
  SESSION_DEAD_AFTER_SECONDS: parseInt(process.env.SESSION_DEAD_AFTER_SECONDS || '900', 10),

  // ---- Alerts (web push to the admin panel PWA) ----
  // Master switch for the background watchdog that raises driver-offline alerts.
  ALERTS_ENABLED: (process.env.ALERTS_ENABLED || 'true').toLowerCase() !== 'false',
  // How often the watchdog scans active trips.
  WATCHDOG_INTERVAL_SECONDS: parseInt(process.env.WATCHDOG_INTERVAL_SECONDS || '30', 10),
  // An active trip silent this long raises a "driver offline" alert. Must sit above the
  // device's stationary keep-alive (30s) and the STALE_AFTER_SECONDS map flag (60s) so a
  // traffic light or a short tunnel never pages a manager. Default 3 min.
  DRIVER_OFFLINE_AFTER_SECONDS: parseInt(process.env.DRIVER_OFFLINE_AFTER_SECONDS || '180', 10),
  // Send a follow-up when a driver that was flagged offline starts reporting again.
  ALERT_ON_BACK_ONLINE: (process.env.ALERT_ON_BACK_ONLINE || 'true').toLowerCase() !== 'false',
  // VAPID keypair for Web Push. Generate once with `npm run vapid` and set BOTH on the
  // server; the public half is handed to browsers so they can create a subscription.
  // Without these, push is disabled (the app still gets in-panel socket alerts).
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@jsan.local',

  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME || 'Super Admin',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@jsan.local',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
};

function parseCorsOrigin(raw) {
  const list = (raw || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Single '*' -> allow all (bare string wildcard). Otherwise -> exact-match list.
  return list.length === 1 && list[0] === '*' ? '*' : list;
}
