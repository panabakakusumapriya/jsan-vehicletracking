const env = require('../config/env');

/**
 * A coarse weather field over the map the manager is looking at — what the animated rain, cloud
 * and wind layers are drawn from.
 *
 * The view is snapped onto a grid whose step grows with the area shown (a city gets ~5 km
 * spacing, a continent a few degrees), so the same view, or one panned a little, lands on the
 * same cached field instead of a new lookup. At most GRID_MAX_CELLS steps a side, which keeps one
 * field to a single multi-location request to the forecast service.
 *
 * Values are per grid point and per hour, flattened row-major from the NORTH-west corner:
 *   precipMm[h][row * cols + col]
 *
 * Like every other weather number in Atlas Ops this is a model forecast, not an observation.
 */
const GRID_MAX_CELLS = 10;
const STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8];
const HOURS = 24;
const FIELDS = 'precipitation,cloud_cover,wind_speed_10m,wind_direction_10m';

const cache = new Map(); // key -> { at, data }

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Snap a bounding box outwards onto the coarsest step that still fits GRID_MAX_CELLS. */
function snapBox({ w, s, e, n }) {
  s = clamp(s, -80, 80);
  n = clamp(n, -80, 80);
  if (e < w) e += 360; // a view across the antimeridian
  const span = Math.max(e - w, n - s, 0.01);
  const step = STEPS.find((st) => span / st <= GRID_MAX_CELLS) ?? STEPS[STEPS.length - 1];
  const floor = (v) => Math.floor(v / step) * step;
  const ceil = (v) => Math.ceil(v / step) * step;
  const box = { step, w: floor(w), s: floor(s), e: ceil(e), n: ceil(n) };
  // Still too wide (only possible at the coarsest step): keep the middle of the view.
  const maxSpan = GRID_MAX_CELLS * step;
  if (box.e - box.w > maxSpan) {
    const mid = floor((box.w + box.e) / 2);
    box.w = mid - (maxSpan / 2);
    box.e = mid + (maxSpan / 2);
  }
  if (box.n - box.s > maxSpan) {
    const mid = floor((box.s + box.n) / 2);
    box.s = clamp(mid - maxSpan / 2, -80, 80);
    box.n = clamp(mid + maxSpan / 2, -80, 80);
  }
  box.cols = Math.round((box.e - box.w) / step) + 1;
  box.rows = Math.round((box.n - box.s) / step) + 1;
  return box;
}

const round = (v) => Math.round(v * 1000) / 1000;
const wrapLon = (v) => ((((v + 180) % 360) + 360) % 360) - 180;

/** The field for a map view, from cache when the same snapped grid was fetched recently. */
async function weatherGrid(view) {
  const box = snapBox(view);
  const key = [box.step, box.w, box.s, box.e, box.n].map(round).join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < env.WEATHER_CACHE_MINUTES * 60_000) {
    return { ...hit.data, fromCache: true };
  }

  const lats = [];
  const lons = [];
  for (let r = 0; r < box.rows; r++) {
    for (let c = 0; c < box.cols; c++) {
      lats.push(round(box.n - r * box.step));
      lons.push(round(wrapLon(box.w + c * box.step)));
    }
  }
  const url =
    `${env.WEATHER_API_BASE}/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${FIELDS}&forecast_hours=${HOURS}&timezone=GMT&timeformat=unixtime&wind_speed_unit=kmh`;

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  } catch (err) {
    if (hit) return { ...hit.data, fromCache: true, stale: true };
    const e = new Error(`Could not reach the weather service (${err.message})`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    if (hit) return { ...hit.data, fromCache: true, stale: true };
    const body = await res.text().catch(() => '');
    const e = new Error(`Weather service returned ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    e.status = 502;
    throw e;
  }
  let json = await res.json();
  if (!Array.isArray(json)) json = [json]; // a one-point grid comes back as a bare object

  const times = json[0]?.hourly?.time || [];
  const n = box.rows * box.cols;
  const field = (name) => times.map((_, h) => {
    const row = new Array(n);
    for (let i = 0; i < n; i++) row[i] = json[i]?.hourly?.[name]?.[h] ?? 0;
    return row;
  });

  const data = {
    step: box.step,
    w: round(box.w), s: round(box.s), e: round(box.e), n: round(box.n),
    cols: box.cols,
    rows: box.rows,
    times,
    precipMm: field('precipitation'),
    cloudPct: field('cloud_cover'),
    windKmh: field('wind_speed_10m'),
    windDirDeg: field('wind_direction_10m'),
    generatedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), data });
  // Bounded: a manager panning around all day must not grow this without limit.
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return { ...data, fromCache: false };
}

module.exports = { weatherGrid, snapBox, GRID_MAX_CELLS, _cache: cache };
