const env = require('../config/env');
const { gridKey, localDayIndex } = require('./drivingWeather');

/**
 * How much to trust a day's forecast, from how well independent weather models AGREE on it.
 *
 * A single forecast cannot say how sure it is. Three independent models can: when ECMWF (Europe),
 * GFS (USA) and ICON (Germany) all put the same rain over the same hours, the day is predictable;
 * when one says dry and another says 8 mm, nobody knows yet, and a manager should plan for both.
 * That spread is the confidence, measured per local day on what matters to a driving day:
 *
 *   temperature  — average hourly spread between the models, °C
 *   wind         — average hourly spread, km/h
 *   rain         — the models' day totals: do they agree on dry vs wet, and on how much
 *   lead time    — a small fixed penalty per day ahead (agreement 6 days out is luckier than at 1)
 *
 * Score 0–100 → high (≥ 75), medium (50–74), low (< 50), with the reasons in plain words.
 * One extra multi-model request per forecast square, cached like the forecast itself; if it fails
 * the cards simply have no confidence bar — the forecast is never held up by it.
 */
const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
const FIELDS = ['temperature_2m', 'precipitation', 'wind_speed_10m'];

const cache = new Map();

async function modelRuns(lat, lon) {
  const key = gridKey(lat, lon);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < env.WEATHER_CACHE_MINUTES * 60_000) return hit.data;
  const url =
    `${env.WEATHER_API_BASE}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${FIELDS.join(',')}&models=${MODELS.join(',')}&forecast_days=${env.WEATHER_FORECAST_DAYS}` +
    `&timezone=GMT&timeformat=unixtime&wind_speed_unit=kmh`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const h = (await res.json()).hourly || {};
    const data = {
      time: h.time || [],
      runs: MODELS.map((m) => ({
        model: m,
        temp: h[`temperature_2m_${m}`] || [],
        rain: h[`precipitation_${m}`] || [],
        wind: h[`wind_speed_10m_${m}`] || [],
      })),
    };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    // Stale beats nothing; nothing beats an error (the bar is a bonus, not the forecast).
    return hit ? hit.data : null;
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const mean = (a) => (a.length ? a.reduce((n, v) => n + v, 0) / a.length : 0);

/** Confidence for one local day. Pure — unit-tested with hand-made model runs. */
function dayConfidence(data, offsetSeconds, dayOffset, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!data?.time?.length) return null;
  const target = localDayIndex(nowSeconds, offsetSeconds) + dayOffset;
  const idx = [];
  data.time.forEach((t, i) => { if (localDayIndex(t, offsetSeconds) === target) idx.push(i); });
  // Models that actually cover the day (GFS and ICON run shorter at some places and leads).
  const runs = data.runs.filter((r) => idx.filter((i) => r.temp[i] != null).length >= idx.length * 0.75);
  if (idx.length < 6 || runs.length < 2) return null;

  const spread = (k) => mean(idx.map((i) => {
    const v = runs.map((r) => r[k][i]).filter((x) => typeof x === 'number');
    return v.length >= 2 ? Math.max(...v) - Math.min(...v) : 0;
  }));
  const tempSpread = spread('temp');
  const windSpread = spread('wind');
  const totals = runs.map((r) => idx.reduce((n, i) => n + (r.rain[i] || 0), 0));
  const rainMin = Math.min(...totals);
  const rainMax = Math.max(...totals);

  const reasons = [];
  let score = 100;
  const tPen = clamp((tempSpread - 1) * 8, 0, 30);
  if (tPen >= 6) reasons.push(`models differ by ${tempSpread.toFixed(1)}°C on temperature`);
  const wPen = clamp((windSpread - 4) * 2, 0, 25);
  if (wPen >= 6) reasons.push(`models differ by ${Math.round(windSpread)} km/h on wind`);
  let rPen = 0;
  if (rainMax >= 1) {
    // Dry-vs-wet disagreement is the one that changes a manager's plan, so it weighs most.
    // Scaled by what is at stake: 0 vs 1 mm is a damp road either way; 0 vs 15 mm is the plan.
    const stake = clamp(rainMax / 4, 0.3, 1);
    rPen = clamp((1 - rainMin / rainMax) * (rainMin < 0.5 ? 40 : 28) * stake, 0, 40);
    if (rPen >= 8) {
      reasons.push(rainMin < 0.5
        ? `models disagree on whether it rains (0–${Math.round(rainMax)} mm)`
        : `models disagree on how much rain (${Math.round(rainMin)}–${Math.round(rainMax)} mm)`);
    }
  }
  const lPen = dayOffset * 3;
  if (dayOffset >= 4) reasons.push(`${dayOffset} days ahead`);
  score = Math.round(clamp(score - tPen - wPen - rPen - lPen, 5, 98));

  const level = score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low';
  if (!reasons.length) reasons.push(level === 'high' ? 'the models agree closely' : 'small differences between the models');
  return {
    score,
    level,
    reasons,
    models: runs.length,
    tempSpreadC: Math.round(tempSpread * 10) / 10,
    windSpreadKmh: Math.round(windSpread),
    rainRangeMm: [Math.round(rainMin * 10) / 10, Math.round(rainMax * 10) / 10],
  };
}

module.exports = { modelRuns, dayConfidence, MODELS, _cache: cache };
