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
  // CORS is no longer configurable — it is always '*'. See the note in app.js.
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

  // ---- Weather (Open-Meteo: no API key required) ----
  // Free endpoint. Open-Meteo licence the free tier for NON-COMMERCIAL use and sell a
  // commercial plan on a different host — point this at that host to switch, no code change.
  WEATHER_API_BASE: process.env.WEATHER_API_BASE || 'https://api.open-meteo.com',
  // Reverse geocoding (OpenStreetMap Nominatim) turns coordinates into place names. Their
  // policy requires a real identifying User-Agent; an anonymous caller gets blocked.
  GEOCODER_USER_AGENT: process.env.GEOCODER_USER_AGENT || 'JSAN-Fleet-Ops/1.0 (fleet ops panel)',
  // A 3-hourly forecast does not change faster than this, and caching is what keeps a
  // 24-driver page load down to a couple of upstream calls.
  WEATHER_CACHE_MINUTES: parseInt(process.env.WEATHER_CACHE_MINUTES || '30', 10),
  // Drivers whose last trip is older than this have no trustworthy position — a months-old
  // fix could put them in the wrong city entirely, so they are listed separately instead.
  WEATHER_ACTIVE_DAYS: parseInt(process.env.WEATHER_ACTIVE_DAYS || '7', 10),
  // Drivers within this many degrees (~25 km) share one forecast.
  WEATHER_GRID_DEGREES: parseFloat(process.env.WEATHER_GRID_DEGREES || '0.25'),
  // Wind thresholds in km/h, tuned for high-sided vans, which catch crosswind far worse than
  // cars. Raise both if the fleet becomes mostly light vehicles.
  WEATHER_WIND_CAUTION_KMH: parseInt(process.env.WEATHER_WIND_CAUTION_KMH || '40', 10),
  WEATHER_GUST_UNSAFE_KMH: parseInt(process.env.WEATHER_GUST_UNSAFE_KMH || '60', 10),

  // ---- Hotels (Booking.com via RapidAPI — METERED, unlike the weather feed) ----
  // Set RAPIDAPI_KEY in .env to override. The fallback below is the key supplied for this
  // build; because it lives in the repo, treat it as public and rotate it before going live.
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY || '8b971fb882msh8f6038d99f96281p1040a5jsn0a1a5df61c89',
  // Every uncached search is a billable call, so results are held far longer than a forecast.
  // Room availability moves in hours, not minutes.
  HOTELS_CACHE_MINUTES: parseInt(process.env.HOTELS_CACHE_MINUTES || '60', 10),
  // Hard stop per UTC day. A stuck page refreshing on a timer could otherwise spend a whole
  // month's plan overnight; this fails loudly instead.
  HOTELS_DAILY_CALL_CAP: parseInt(process.env.HOTELS_DAILY_CALL_CAP || '150', 10),
  // Drivers within ~1 km share a cached search — they would be offered the same beds anyway.
  HOTELS_GRID_DEGREES: parseFloat(process.env.HOTELS_GRID_DEGREES || '0.01'),
  // Provider accepts 10–500 km. 30 km is a sensible night-stop radius for someone already
  // tired; the manager can widen it per search.
  HOTELS_DEFAULT_RADIUS_KM: parseInt(process.env.HOTELS_DEFAULT_RADIUS_KM || '30', 10),
  HOTELS_MAX_NIGHTS: parseInt(process.env.HOTELS_MAX_NIGHTS || '30', 10),
  HOTELS_CURRENCY: (process.env.HOTELS_CURRENCY || 'INR').toUpperCase(),
  // Same position window the weather tab uses: an older fix could put a driver in the wrong
  // city, and booking a room in the wrong city is worse than saying "unknown".
  HOTELS_ACTIVE_DAYS: parseInt(process.env.HOTELS_ACTIVE_DAYS || '7', 10),
  HOTELS_TIMEOUT_MS: parseInt(process.env.HOTELS_TIMEOUT_MS || '15000', 10),

  // ---- Couriers (FedEx/DHL/UPS-type drop-off points via Serper.dev Places — METERED) ----
  // Unlike RAPIDAPI_KEY above, this has NO source-committed fallback — set SERPER_API_KEY in
  // .env only. Serper's free tier is a ONE-TIME 2,500-query bucket (not a monthly reset), so
  // an accidentally-public key here would be a bigger, harder-to-notice leak than a metered
  // subscription would be.
  SERPER_API_KEY: process.env.SERPER_API_KEY || '',
  // Courier drop-off points don't move; cache far longer than hotel room availability.
  COURIER_CACHE_MINUTES: parseInt(process.env.COURIER_CACHE_MINUTES || '360', 10),
  // Conservative default: the free tier never refills, so burning it on a stuck auto-refresh
  // would be a permanent loss, not just "wait for tomorrow" like the hotel budget.
  COURIER_DAILY_CALL_CAP: parseInt(process.env.COURIER_DAILY_CALL_CAP || '80', 10),
  // Drivers within ~1 km share a cached search.
  COURIER_GRID_DEGREES: parseFloat(process.env.COURIER_GRID_DEGREES || '0.01'),
  COURIER_DEFAULT_RADIUS_KM: parseInt(process.env.COURIER_DEFAULT_RADIUS_KM || '15', 10),
  // Same freshness window the hotel/weather tabs use for "is this position still trustworthy".
  COURIER_ACTIVE_DAYS: parseInt(process.env.COURIER_ACTIVE_DAYS || '7', 10),
  COURIER_TIMEOUT_MS: parseInt(process.env.COURIER_TIMEOUT_MS || '15000', 10),

  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME || 'Super Admin',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@jsan.local',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
};
