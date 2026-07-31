const env = require('../config/env');
const Trip = require('../models/Trip');
const User = require('../models/User');
const { assessDay, gridKey, localTime } = require('./drivingWeather');
const { classifyWmo, iconFor } = require('./weatherCodes');
const { reverseGeocodeMany } = require('./geocode');

/**
 * Forecasts come from Open-Meteo — no API key at all, hourly resolution, and wind already in
 * km/h. See docs: https://open-meteo.com/en/docs
 *
 * NOTE ON LICENSING: the free endpoint below is for non-commercial use. Open-Meteo sell a
 * commercial plan on a different host; `WEATHER_API_BASE` exists so switching to it is one
 * env var, not a code change.
 */
const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'weather_code',
  'wind_speed_10m',
  'wind_gusts_10m',
  'visibility',
  'precipitation',
  'precipitation_probability',
  'is_day',
].join(',');

/**
 * In-memory forecast cache, keyed by grid square.
 *
 * Drivers are clustered onto a ~25 km grid before anything is fetched, and each square is
 * cached for WEATHER_CACHE_MINUTES. A depot of twenty drivers is therefore one call every
 * half hour, not twenty calls per page load.
 *
 * Deliberately per-process: it is a cache, not state. A restart just refetches.
 */
const cache = new Map(); // key -> { at: ms, data }

/** Open-Meteo needs no key, so the feature is always available. */
function isConfigured() {
  return true;
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  const ageMs = Date.now() - hit.at;
  if (ageMs > env.WEATHER_CACHE_MINUTES * 60_000) return null;
  // `fromCache` is explicit rather than inferred from the age: a hit less than a second old
  // rounds to zero seconds and would otherwise look like a fresh fetch.
  return { ...hit.data, fromCache: true, cachedAgeSeconds: Math.round(ageMs / 1000) };
}

/** Columnar Open-Meteo arrays → the normalised slots the scoring rules expect. */
function normalise(json) {
  const h = json.hourly || {};
  const times = h.time || [];
  return times.map((dt, i) => {
    const code = h.weather_code?.[i];
    const { description, severity } = classifyWmo(code);
    return {
      dt, // unix seconds, because we request timeformat=unixtime
      tempC: h.temperature_2m?.[i] ?? null,
      feelsLikeC: h.apparent_temperature?.[i] ?? null,
      windKmh: h.wind_speed_10m?.[i] ?? null,
      gustKmh: h.wind_gusts_10m?.[i] ?? null,
      visibilityM: h.visibility?.[i] ?? null,
      popPct: h.precipitation_probability?.[i] ?? 0,
      precipMm: h.precipitation?.[i] ?? 0,
      severity,
      description,
      icon: iconFor(code, h.is_day?.[i] !== 0),
    };
  });
}

/** Fetch (or reuse) the hourly 5-day forecast for one grid square. */
async function forecastFor(lat, lon) {
  const key = gridKey(lat, lon);
  const hit = cached(key);
  if (hit) return hit;

  const url =
    `${env.WEATHER_API_BASE}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${HOURLY_FIELDS}&forecast_days=5` +
    // unixtime keeps everything in UTC seconds; the offset below does the local-day maths.
    `&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    const stale = cache.get(key);
    if (stale) {
      return { ...stale.data, stale: true, fromCache: true, cachedAgeSeconds: Math.round((Date.now() - stale.at) / 1000) };
    }
    const e = new Error(`Could not reach the weather service (${err.message})`);
    e.status = 502;
    throw e;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Serve a stale forecast rather than nothing — an hour-old forecast still answers
    // "can they drive today" far better than an error page does.
    const stale = cache.get(key);
    if (stale) {
      return { ...stale.data, stale: true, fromCache: true, cachedAgeSeconds: Math.round((Date.now() - stale.at) / 1000) };
    }
    const err = new Error(`Weather service returned ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    err.status = 502;
    throw err;
  }

  const json = await res.json();
  const data = {
    slots: normalise(json),
    timezoneOffset: json.utc_offset_seconds ?? 0,
    timezoneName: json.timezone || null,
    lat: json.latitude ?? lat,
    lon: json.longitude ?? lon,
  };
  cache.set(key, { at: Date.now(), data });
  return { ...data, fromCache: false, cachedAgeSeconds: 0 };
}

/**
 * Latest known position per driver, limited to drivers who have driven recently.
 *
 * A months-old fix is worse than no fix — it would confidently show the weather for a city
 * the driver has long left — so anything older than WEATHER_ACTIVE_DAYS is excluded here and
 * surfaced separately as "no recent location".
 */
async function recentDriverPositions(scope) {
  const cutoff = new Date(Date.now() - env.WEATHER_ACTIVE_DAYS * 86400_000);

  const rows = await Trip.aggregate([
    { $match: { ...scope, lastLocation: { $ne: null }, startedAt: { $gte: cutoff } } },
    { $sort: { startedAt: -1 } },
    {
      $group: {
        _id: '$driverId',
        lat: { $first: '$lastLocation.lat' },
        lon: { $first: '$lastLocation.lon' },
        at: { $first: '$lastLocation.recordedAt' },
      },
    },
  ]);

  return rows.filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number');
}

/**
 * The whole picture for one day: every location that has drivers, judged, plus the drivers
 * we could not place.
 */
async function drivingConditions({ scope, dayOffset = 0 }) {
  const driverFilter = { role: 'user', active: true };
  if (scope.driverId) driverFilter._id = scope.driverId;
  const drivers = await User.find(driverFilter).select('name email country project').sort({ name: 1 });
  const byId = new Map(drivers.map((d) => [String(d._id), d]));

  const positions = await recentDriverPositions(scope);
  const placed = new Set();

  // Cluster first, fetch second — this is what turns N drivers into a handful of lookups.
  const squares = new Map(); // gridKey -> { lat, lon, drivers: [] }
  for (const p of positions) {
    const driver = byId.get(String(p._id));
    if (!driver) continue; // inactive or out of scope
    placed.add(String(p._id));
    const key = gridKey(p.lat, p.lon);
    if (!squares.has(key)) squares.set(key, { lat: p.lat, lon: p.lon, drivers: [] });
    squares.get(key).drivers.push({
      _id: driver._id,
      name: driver.name,
      country: driver.country,
      project: driver.project,
      lastSeenAt: p.at,
    });
  }

  const settled = await Promise.allSettled(
    [...squares.entries()].map(async ([key, square]) => {
      const forecast = await forecastFor(square.lat, square.lon);
      const day = assessDay(forecast.slots, forecast.timezoneOffset, dayOffset);
      return {
        key,
        lat: forecast.lat,
        lon: forecast.lon,
        timezoneName: forecast.timezoneName,
        localTimeNow: localTime(Math.floor(Date.now() / 1000), forecast.timezoneOffset),
        stale: Boolean(forecast.stale),
        fromCache: Boolean(forecast.fromCache),
        cachedAgeSeconds: forecast.cachedAgeSeconds ?? 0,
        drivers: square.drivers,
        ...day,
      };
    })
  );

  const groups = [];
  const failures = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') groups.push(r.value);
    else failures.push(r.reason?.message || 'forecast lookup failed');
  }

  // Names are a separate, permanently-cached lookup; a slow or unavailable geocoder must
  // never hold up the forecast, so anything unresolved falls back to coordinates.
  const names = await reverseGeocodeMany(groups.map((g) => ({ key: g.key, lat: g.lat, lon: g.lon })));
  for (const g of groups) {
    const hit = names.get(g.key);
    g.place = hit?.place || null;
    g.country = hit?.country || null;
  }

  // Worst first: the locations that need a decision belong at the top.
  const order = { unsafe: 0, caution: 1, clear: 2 };
  groups.sort((a, b) => (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3) || b.drivers.length - a.drivers.length);

  const unplaced = drivers
    .filter((d) => !placed.has(String(d._id)))
    .map((d) => ({ _id: d._id, name: d.name, country: d.country, project: d.project }));

  const countDrivers = (verdict) =>
    groups.filter((g) => g.verdict === verdict).reduce((n, g) => n + g.drivers.length, 0);

  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    dayOffset,
    groups,
    unplaced,
    failures,
    totals: {
      clear: countDrivers('clear'),
      caution: countDrivers('caution'),
      unsafe: countDrivers('unsafe'),
      unplaced: unplaced.length,
      locations: groups.length,
      apiCalls: groups.filter((g) => !g.fromCache).length,
    },
  };
}

module.exports = { drivingConditions, isConfigured, forecastFor, normalise, _cache: cache };
