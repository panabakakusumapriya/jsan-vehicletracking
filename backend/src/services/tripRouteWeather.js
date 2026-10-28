const env = require('../config/env');
const LocationPoint = require('../models/LocationPoint');
const { haversineMeters } = require('../utils/geo');
const { classifyWmo, iconFor } = require('./weatherCodes');
const { scoreSlot, CLEAR, RANK } = require('./drivingWeather');

/**
 * Estimated weather ALONG a finished trip: the place the vehicle was at each moment, matched to
 * the modelled weather for that place and hour. This is what the trip replay shows beside the GPS
 * track and the stops.
 *
 * It is an ESTIMATE, and every response says so: the numbers come from a weather model's
 * hindcast on a ~1–10 km grid (Open-Meteo's historical-forecast archive), not from a sensor on
 * the vehicle. Good for "was it pouring when coverage dropped", not for an incident report.
 *
 * Sampling: one point every SAMPLE_MINUTES of driving or SAMPLE_KM of road, whichever comes first,
 * plus the start and the end, capped at MAX_SAMPLES by widening the interval. Nearby samples share
 * a grid point, so a 6-hour city day is a handful of locations in ONE request.
 */
const SAMPLE_MINUTES = 15;
const SAMPLE_KM = 10;
const MAX_SAMPLES = 40;
const SNAP_DEG = 0.05; // ~5 km; finer than that the model has nothing more to say
const FIELDS = [
  'temperature_2m', 'apparent_temperature', 'weather_code', 'precipitation',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'visibility', 'cloud_cover', 'is_day',
].join(',');

// Finished trips do not change, so their weather is cached by id until the process restarts.
const cache = new Map();
const CACHE_MAX = 500;

/** Pick the moments to look the weather up at. Pure, so it is unit-tested on its own. */
function pickSamples(points) {
  if (!points.length) return [];
  const durationMin = (points[points.length - 1].t - points[0].t) / 60_000;
  const everyMin = Math.max(SAMPLE_MINUTES, durationMin / (MAX_SAMPLES - 1));
  const out = [];
  let km = 0;
  let last = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) km += haversineMeters(points[i - 1], p) / 1000;
    const isLast = i === points.length - 1;
    if (
      !last ||
      isLast ||
      (p.t - last.t) / 60_000 >= everyMin ||
      // Fast stretches sample by road distance, but never more often than every few minutes.
      (km - last.km >= SAMPLE_KM && (p.t - last.t) / 60_000 >= everyMin / 3)
    ) {
      // The end replaces a sample taken moments before it rather than crowding next to it.
      if (isLast && last && (p.t - last.t) < 5 * 60_000 && out.length > 1) out.pop();
      last = { t: p.t, lat: p.lat, lon: p.lon, km };
      out.push(last);
    }
  }
  if (out.length <= MAX_SAMPLES) return out;
  // Too many (a long fast drive): thin evenly, always keeping the start and the end.
  const thin = [];
  for (let k = 0; k < MAX_SAMPLES; k++) thin.push(out[Math.round((k * (out.length - 1)) / (MAX_SAMPLES - 1))]);
  return thin;
}

const snap = (v) => Math.round(v / SNAP_DEG) * SNAP_DEG;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Fetch the hourly hindcast for a set of snapped places across [fromMs, toMs]. */
async function fetchHindcast(places, fromMs, toMs) {
  const url =
    `${env.WEATHER_HISTORY_API_BASE}/v1/forecast` +
    `?latitude=${places.map((p) => p.lat.toFixed(3)).join(',')}` +
    `&longitude=${places.map((p) => p.lon.toFixed(3)).join(',')}` +
    `&start_date=${day(fromMs)}&end_date=${day(toMs)}` +
    `&hourly=${FIELDS}&timezone=GMT&timeformat=unixtime&wind_speed_unit=kmh`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`Weather archive returned ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    e.status = 502;
    throw e;
  }
  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

/**
 * One sample's weather from its place's hourly series.
 *
 * Open-Meteo reports precipitation as the sum of the PRECEDING hour, so the rain falling between
 * 10:00 and 11:00 is the 11:00 value; temperature and wind are instantaneous and are interpolated
 * between the two hours around the sample.
 */
function weatherAt(series, tMs) {
  const h = series?.hourly;
  const times = h?.time || [];
  if (!times.length) return null;
  const t = tMs / 1000;
  let i = times.findIndex((x) => x > t) - 1;
  if (i < 0) i = t < times[0] ? 0 : times.length - 1;
  const j = Math.min(i + 1, times.length - 1);
  const f = j === i ? 0 : Math.min(Math.max((t - times[i]) / (times[j] - times[i]), 0), 1);
  const lerp = (k) => {
    const a = h[k]?.[i];
    const b = h[k]?.[j];
    if (a == null) return b ?? null;
    if (b == null) return a;
    return a + (b - a) * f;
  };
  const code = h.weather_code?.[f < 0.5 ? i : j];
  const { description, severity } = classifyWmo(code);
  return scoreSlot({
    dt: Math.round(t),
    tempC: lerp('temperature_2m'),
    feelsLikeC: lerp('apparent_temperature'),
    windKmh: lerp('wind_speed_10m'),
    gustKmh: lerp('wind_gusts_10m'),
    windDirDeg: h.wind_direction_10m?.[i] ?? null,
    visibilityM: lerp('visibility'),
    cloudPct: lerp('cloud_cover'),
    precipMm: h.precipitation?.[j] ?? 0,
    popPct: 0,
    severity,
    description,
    icon: iconFor(code, h.is_day?.[i] !== 0),
  });
}

/** The estimated weather along a trip, or null when it has no usable GPS. */
async function tripRouteWeather(trip) {
  const id = String(trip._id);
  const hit = cache.get(id);
  if (hit && hit.endedAt === String(trip.endedAt)) return { ...hit.data, fromCache: true };

  const rows = await LocationPoint.find({ tripId: trip._id })
    .select('lat lon recordedAt')
    .sort({ recordedAt: 1 })
    .lean();
  const points = rows
    .filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number' && r.recordedAt)
    .map((r) => ({ lat: r.lat, lon: r.lon, t: new Date(r.recordedAt).getTime() }));
  if (!points.length && trip.startLocation?.lat != null && trip.startedAt) {
    // Trips whose points are gone still have where and when they started.
    points.push({ lat: trip.startLocation.lat, lon: trip.startLocation.lon, t: new Date(trip.startedAt).getTime() });
  }
  if (!points.length) return null;

  const samples = pickSamples(points);
  const places = [];
  const placeOf = new Map();
  for (const s of samples) {
    const key = `${snap(s.lat).toFixed(3)},${snap(s.lon).toFixed(3)}`;
    if (!placeOf.has(key)) {
      placeOf.set(key, places.length);
      places.push({ lat: snap(s.lat), lon: snap(s.lon) });
    }
    s.place = placeOf.get(key);
  }

  const series = await fetchHindcast(places, samples[0].t, samples[samples.length - 1].t);
  const out = samples.map((s) => {
    const w = weatherAt(series[s.place], s.t);
    return {
      at: new Date(s.t).toISOString(),
      lat: s.lat,
      lon: s.lon,
      kmFromStart: Math.round(s.km * 10) / 10,
      ...(w && {
        risk: w.risk,
        reasons: w.reasons,
        tempC: w.tempC,
        feelsLikeC: w.feelsLikeC == null ? null : Math.round(w.feelsLikeC),
        windKmh: w.windKmh,
        gustKmh: w.gustKmh,
        windDirDeg: w.windDirDeg == null ? null : Math.round(w.windDirDeg),
        visibilityKm: w.visibilityKm,
        cloudPct: w.cloudPct == null ? null : Math.round(w.cloudPct),
        precipMm: Math.round((w.precipMm || 0) * 10) / 10,
        description: w.description,
        icon: w.icon,
      }),
    };
  });

  const scored = out.filter((s) => s.risk);
  const nums = (k) => scored.map((s) => s[k]).filter((v) => typeof v === 'number');
  const verdict = scored.reduce((acc, s) => (RANK[s.risk] > RANK[acc] ? s.risk : acc), CLEAR);
  const data = {
    estimate: true,
    source: 'Modelled hindcast (Open-Meteo historical forecast), not measured by the vehicle',
    verdict,
    samples: out,
    summary: {
      tempMinC: nums('tempC').length ? Math.min(...nums('tempC')) : null,
      tempMaxC: nums('tempC').length ? Math.max(...nums('tempC')) : null,
      wetSamples: scored.filter((s) => s.precipMm >= 0.2).length,
      maxPrecipMm: nums('precipMm').length ? Math.max(...nums('precipMm')) : 0,
      gustMaxKmh: nums('gustKmh').length ? Math.max(...nums('gustKmh')) : null,
      visibilityMinKm: nums('visibilityKm').length ? Math.min(...nums('visibilityKm')) : null,
      places: places.length,
    },
  };
  cache.set(id, { endedAt: String(trip.endedAt), data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return { ...data, fromCache: false };
}

module.exports = { tripRouteWeather, pickSamples, weatherAt, _cache: cache };
