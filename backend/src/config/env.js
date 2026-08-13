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
  // Admin/manager/team_lead tokens — these roles sign in from a browser fairly often, so a
  // shorter lifetime is a small inconvenience, not a support ticket.
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  // Driver-portal (mobile app) tokens. Drivers already carry a single-session lock
  // (activeSessionId, see auth.controller.js) — a lost/stolen phone is revoked by
  // deactivating the account, not by waiting out the JWT — so a long-lived token here trades
  // away little security for a lot fewer "why do I have to log in again" reports from the
  // field. Defaults to 365d with no Railway env change required; set DRIVER_JWT_EXPIRES_IN to
  // override.
  DRIVER_JWT_EXPIRES_IN: process.env.DRIVER_JWT_EXPIRES_IN || '365d',
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

  // ---- Map matching (Valhalla — HMM snap-to-road, cleans up GPS noise in distanceMeters) ----
  // Master switch for the background worker (services/mapMatcher.js) that snaps each
  // completed trip's raw GPS trace onto the road network.
  VALHALLA_ENABLED: (process.env.VALHALLA_ENABLED || 'true').toLowerCase() !== 'false',
  // FOSSGIS's free community instance — no key, no billing, best-effort uptime. Env-configurable
  // so pointing this at a self-hosted Valhalla later (for a guaranteed SLA) is a one-line change,
  // not a code change.
  VALHALLA_URL: process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de',
  // Community routing servers expect an identifying User-Agent (same reasoning as
  // GEOCODER_USER_AGENT above); an anonymous caller risks being blocked.
  VALHALLA_USER_AGENT: process.env.VALHALLA_USER_AGENT || 'JSAN-Fleet-Ops/1.0 (fleet map-matching)',
  VALHALLA_TIMEOUT_MS: parseInt(process.env.VALHALLA_TIMEOUT_MS || '20000', 10),
  // Minimum spacing between outbound Valhalla requests — good-citizen throttling for the free
  // community server (same idea as geocode.js's Nominatim pacing).
  VALHALLA_MIN_INTERVAL_MS: parseInt(process.env.VALHALLA_MIN_INTERVAL_MS || '600', 10),
  // How often the worker sweeps for newly-completed trips awaiting a match.
  MAP_MATCH_INTERVAL_SECONDS: parseInt(process.env.MAP_MATCH_INTERVAL_SECONDS || '30', 10),
  // Trips matched per tick — a throttle (like the watchdog's alert cap), not a coverage limit;
  // whatever's left over is picked up on the next tick. Keeps a backlog from hammering the
  // free community server all at once.
  MAP_MATCH_MAX_PER_TICK: parseInt(process.env.MAP_MATCH_MAX_PER_TICK || '5', 10),
  // Valhalla traces get chunked past this many points per /trace_route call, since a long
  // offline-sync trip (thousands of points) is not a reasonable single request against shared
  // community infra.
  MAP_MATCH_CHUNK_SIZE: parseInt(process.env.MAP_MATCH_CHUNK_SIZE || '1000', 10),
  // Trips shorter than this (parked/GPS-blip sessions) are marked "skipped" rather than
  // spending a Valhalla call on a trace with nothing meaningful to snap.
  MAP_MATCH_MIN_DISTANCE_METERS: parseInt(process.env.MAP_MATCH_MIN_DISTANCE_METERS || '30', 10),
  // Gap-filling (routing between two points across a signal dropout, via Valhalla's /route) is
  // implemented but OFF by default — it fabricates road geometry for a stretch nothing actually
  // observed, which is a bigger judgment call than snapping an existing trace onto the road.
  GAP_FILL_ENABLED: (process.env.GAP_FILL_ENABLED || 'false').toLowerCase() === 'true',
  // A silence this long between two consecutive fixes is treated as a signal dropout worth
  // bridging (not just ordinary GPS spacing). Only consulted when GAP_FILL_ENABLED is true.
  GAP_FILL_MIN_SECONDS: parseInt(process.env.GAP_FILL_MIN_SECONDS || '90', 10),

  // ---- Matcher tuning: why snapped routes were losing driver U-turns ----
  // Both defaults below were picked by replaying synthetic out-and-back traces (a real Valhalla
  // route driven to a point and back, resampled as GPS fixes with correlated noise) against the
  // live community server and comparing the matched length to the known truth.
  //
  // Sending per-point timestamps is what broke matching worst. Valhalla prunes any transition
  // whose routed time exceeds max_route_time_factor (default 5) x the measured time between two
  // fixes, so a vehicle simply driving FASTER than Valhalla's modelled speed for that road has
  // its transitions rejected wholesale. A trace at 40 km/h on a road Valhalla models at 10 km/h
  // matched 61 m of a known 3390 m route (2%) with timestamps and the full 3390 m (100%) without
  // — and raising max_route_time_factor via trace_options did NOT help, because the community
  // server's meili config does not expose those factors as per-request customizable (search_radius
  // and gps_accuracy demonstrably ARE — setting search_radius to 1 visibly wrecks the match).
  // Dropping the timestamps is therefore the only lever available against a shared server, and it
  // costs nothing: matchDenseRun reads only leg.summary.length, never a duration, and never asks
  // for use_timestamps. Flip this on only against a self-hosted Valhalla with the factors raised.
  MAP_MATCH_SEND_TIMESTAMPS: (process.env.MAP_MATCH_SEND_TIMESTAMPS || 'false').toLowerCase() === 'true',
  // Valhalla's stock 50 m candidate-search radius is the second U-turn killer, and the subtler
  // one. At the apex the vehicle crosses to the opposite carriageway, where GPS noise is at its
  // worst (slow, stationary-ish, multipath) — so the return-side road edge falls outside 50 m of
  // those fixes, never enters the candidate set, and the matcher has no return-leg hypothesis to
  // choose. It then snaps the whole manoeuvre onto the outbound side: the same 3390 m route
  // matched 1744 m (51% — precisely the return leg dropped) at 50 m and 3485 m (103%) at 60 m.
  // Kept modest on purpose; Valhalla caps this at max_search_radius (100 m by default) and a wide
  // radius starts pulling matches onto parallel side streets in dense grids.
  MAP_MATCH_SEARCH_RADIUS: parseInt(process.env.MAP_MATCH_SEARCH_RADIUS || '60', 10),
  // Tells the matcher how noisy these fixes really are (Valhalla assumes an optimistic 5 m).
  // On its own it changed nothing; paired with the wider search radius above it is what let the
  // return leg win. 15 m reflects phone GPS in traffic, not open-sky best case.
  MAP_MATCH_GPS_ACCURACY: parseInt(process.env.MAP_MATCH_GPS_ACCURACY || '15', 10),

  // ---- Coverage checking: why whole roads were missing from snapped routes ----
  // Valhalla does not report a failed match by erroring. Given driving it cannot resolve it
  // returns HTTP 200 and a well-formed trip whose legs cover almost none of the input — one real
  // trip fed 1000 points spanning 14.71 km and got back a single 40 m leg, which the old code
  // stored as the answer. 24% of that trip vanished from the map with nothing recording it.
  //
  // So a match is now measured against the straight-line length of the points behind it and
  // rejected below this ratio. 0.6 sits well clear of both populations actually observed: real
  // matches land at 84-101% of straight-line length (higher than 100% because roads bend around
  // the chord), while collapses land at 3-21%. Nothing observed fell between 44% and 84%.
  MAP_MATCH_MIN_COVERAGE: parseFloat(process.env.MAP_MATCH_MIN_COVERAGE || '0.6'),
  // Coverage is necessary but NOT sufficient, and this pair is the other half of the test. A
  // trace can be snapped onto entirely the wrong streets and still come back the right total
  // length: a real trip with clean 2-second fixes passed the coverage gate on both its chunks
  // while 14.4% of its points sat over 100 m from the road it had been snapped to, drifting onto
  // parallel streets for 300-1200 m at a time. So a match is also required to stay NEAR the fixes
  // that produced it — this is what makes "snapped to the nearest road" a guarantee rather than a
  // hope. 100 m is far beyond real GPS error (good matches sit at a 4-6 m median, 8 m p90) but
  // still well inside the width of a wrong-street excursion. 90% rather than 100% leaves room for
  // the genuinely noisy handful every urban trace contains.
  MAP_MATCH_MAX_DEVIATION_METERS: parseInt(process.env.MAP_MATCH_MAX_DEVIATION_METERS || '100', 10),
  MAP_MATCH_MIN_POINTS_ON_ROUTE: parseFloat(process.env.MAP_MATCH_MIN_POINTS_ON_ROUTE || '0.9'),
  // A rejected stretch is halved and retried, because the failure is usually local: in that same
  // trip, consecutive 100-point windows scored 3%, 21%, 101%, 91%, 16%, 92%, 84%, 44%, 13%, 100%.
  // Splitting rescues the matchable half instead of discarding the whole chunk.
  MAP_MATCH_MAX_SPLIT_DEPTH: parseInt(process.env.MAP_MATCH_MAX_SPLIT_DEPTH || '5', 10),
  // Stop splitting here and fall back to raw geometry. Below roughly this many points a stretch
  // is too short to give the matcher useful evidence, so further halving just multiplies requests
  // against a shared community server without changing the outcome.
  MAP_MATCH_MIN_SPLIT_POINTS: parseInt(process.env.MAP_MATCH_MIN_SPLIT_POINTS || '40', 10),
  // Break the trace at silences this long before matching anything, independently of gap-filling.
  // A pause is a real discontinuity in the evidence; feeding one to the matcher as though it were
  // continuous driving makes it reason about a jump nothing observed. Deliberately far shorter
  // than GAP_FILL_MIN_SECONDS: splitting is cheap and safe, inventing bridge geometry across a
  // dropout is the part that needs a high bar.
  //
  // 45s, not lower, and the reason is counter-intuitive. Splitting harder is not better: on the
  // trip that exposed all this, thresholds of 20s / 45s / 90s / never produced 95% / 98% / 95% /
  // 95% genuinely-snapped in 43 / 28 / 34 / 34 requests. 20s is inside the range of an ordinary
  // red light, so it shatters normal driving into runs too short for the matcher to resolve, and
  // those fragments then fall back to raw geometry — more requests AND a worse result. 45s clears
  // routine traffic stops while still cutting genuine dropouts.
  MAP_MATCH_SPLIT_GAP_SECONDS: parseInt(process.env.MAP_MATCH_SPLIT_GAP_SECONDS || '45', 10),
};
