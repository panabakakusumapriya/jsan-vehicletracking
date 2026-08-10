const env = require('../config/env');
const { haversineMeters } = require('../utils/geo');

/**
 * Nearby courier/shipping locations (FedEx, DHL, UPS and everything else Google Maps has
 * tagged as shipping/courier), via Serper.dev's Places search.
 *
 * Two things about this provider shape the file:
 *
 * 1. NO COORDINATE SEARCH. Serper's `ll` (raw lat/lon) parameter was tested and does not
 *    actually bias results — three different known-good coordinate pairs all returned
 *    unrelated U.S. cities. What works is a place-NAME string in `location` (e.g. "Hyderabad,
 *    Telangana, India" — confirmed empirically; a bare ISO country code like "Hyderabad, IN"
 *    also silently fails). So the caller must already have reverse-geocoded the driver's
 *    position into a name — see courierSearch.js.
 *
 * 2. CALLS COST MONEY, AND THE FREE TIER NEVER REFILLS. Serper's free allowance is a
 *    ONE-TIME 2,500-query bucket, not a monthly reset like a typical API plan. So this is
 *    cached even harder than Hotels, and the daily budget is a hedge against burning through
 *    a permanent allowance rather than "wait for tomorrow".
 *
 * There is no true radius parameter either — Serper/Google biases toward the named place but
 * can still return results well outside any sane "near the driver" radius, so — same as
 * Hotels — actual distance is computed here from coordinates and enforced by the caller.
 */
const HOST = 'google.serper.dev';
const SEARCH_PATH = '/places';

/** Cached responses keyed by every parameter that changes the answer. */
const cache = new Map(); // key -> { at: ms, data }

/** Per-UTC-day call budget. */
const budget = { day: null, used: 0 };

const utcDay = () => new Date().toISOString().slice(0, 10);

function currentBudget() {
  if (budget.day !== utcDay()) {
    budget.day = utcDay();
    budget.used = 0;
  }
  return budget;
}

function budgetStatus() {
  const b = currentBudget();
  return { used: b.used, cap: env.COURIER_DAILY_CALL_CAP, remaining: Math.max(0, env.COURIER_DAILY_CALL_CAP - b.used) };
}

function isConfigured() {
  return Boolean(env.SERPER_API_KEY);
}

function fail(msg, status = 502, extra = {}) {
  const err = new Error(msg);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function cacheKey(q) {
  // Coordinates are snapped first: two drivers a few hundred metres apart want the same
  // search. The resolved location NAME is part of the key too — it is what actually
  // determines the provider call, and two nearby grid squares could resolve to different
  // localities near a boundary.
  const snap = (v) => (Math.round(v / env.COURIER_GRID_DEGREES) * env.COURIER_GRID_DEGREES).toFixed(3);
  return [snap(q.lat), snap(q.lon), q.locationName, q.query].join('|');
}

/** One raw place → the fields a fleet manager actually needs. */
function mapPlace(raw, origin) {
  const lat = typeof raw.latitude === 'number' ? raw.latitude : null;
  const lon = typeof raw.longitude === 'number' ? raw.longitude : null;

  const distanceKm =
    lat != null && lon != null && origin
      ? Math.round(haversineMeters(origin, { lat, lon }) / 100) / 10
      : null;

  return {
    id: raw.cid || raw.placeId || null,
    name: raw.title || 'Unnamed location',
    address: raw.address || null,
    category: raw.category || null,
    phone: raw.phoneNumber || null,
    website: raw.website || null,
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    ratingCount: typeof raw.ratingCount === 'number' ? raw.ratingCount : 0,
    lat, lon, distanceKm,
  };
}

/**
 * Call the provider (or reuse a cached answer).
 *
 * Returns `{ places, totalFound, fromCache, cachedAgeSeconds }`.
 */
async function searchNearby(q) {
  if (!isConfigured()) {
    throw fail('No Serper API key configured — set SERPER_API_KEY to enable courier search.', 503);
  }

  const key = cacheKey(q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= env.COURIER_CACHE_MINUTES * 60_000) {
    return { ...hit.data, fromCache: true, cachedAgeSeconds: Math.round((Date.now() - hit.at) / 1000) };
  }

  const b = currentBudget();
  if (b.used >= env.COURIER_DAILY_CALL_CAP) {
    throw fail(
      `Daily courier-search budget reached (${env.COURIER_DAILY_CALL_CAP} calls). ` +
        'Raise COURIER_DAILY_CALL_CAP if the plan allows more — note the free Serper tier is a one-time allowance, not a monthly reset.',
      429,
      { budget: budgetStatus() }
    );
  }

  let res;
  b.used += 1;
  try {
    res = await fetch(`https://${HOST}${SEARCH_PATH}`, {
      method: 'POST',
      headers: {
        'X-API-KEY': env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: q.query, location: q.locationName }),
      signal: AbortSignal.timeout(env.COURIER_TIMEOUT_MS),
    });
  } catch (err) {
    throw fail(`Could not reach the courier-location service (${err.message})`);
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('Serper rejected the API key (401/403) — check SERPER_API_KEY.', 502);
  }
  if (res.status === 429) {
    throw fail('Serper rate/credit limit reached for this key.', 429);
  }
  if (!res.ok) {
    throw fail(`Courier-location service returned HTTP ${res.status}`);
  }

  const json = await res.json().catch(() => null);
  if (!json) throw fail('Courier-location service returned a response that was not JSON');

  const origin = { lat: q.lat, lon: q.lon };
  const places = (json.places || []).map((raw) => mapPlace(raw, origin));

  const data = { places, totalFound: places.length };
  cache.set(key, { at: Date.now(), data });
  return { ...data, fromCache: false, cachedAgeSeconds: 0 };
}

module.exports = {
  searchNearby,
  isConfigured,
  budgetStatus,
  // exported for tests
  mapPlace,
  cacheKey,
  _cache: cache,
  _budget: budget,
};
