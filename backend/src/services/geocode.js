const env = require('../config/env');

/**
 * Reverse geocoding via OpenStreetMap's Nominatim — no API key, same project whose tiles the
 * map already uses.
 *
 * Coordinates are cached FOREVER: the town at a given grid square does not change, so one
 * lookup per location is a permanent cost, not a recurring one.
 *
 * Nominatim's usage policy caps this at one request per second and requires an identifying
 * User-Agent, so lookups are queued rather than fired in parallel. To keep a first page load
 * from stalling behind a queue of them, callers get whatever has resolved within a short
 * budget and coordinates for the rest — the names fill in on the next load.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const cache = new Map(); // gridKey -> { place, country } | null (null = looked up, unknown)

let lastCallAt = 0;

async function politeDelay() {
  const since = Date.now() - lastCallAt;
  const wait = Math.max(0, 1100 - since); // Nominatim: max 1 request/second
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function lookup(key, lat, lon) {
  if (cache.has(key)) return cache.get(key);
  await politeDelay();

  const url = `${NOMINATIM}?lat=${lat}&lon=${lon}&format=jsonv2&zoom=10&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: {
        // Nominatim requires a real identifier; an anonymous caller gets blocked.
        'User-Agent': env.GEOCODER_USER_AGENT,
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null; // not cached: a 429/5xx is worth retrying later
    const json = await res.json();
    const a = json.address || {};
    const place =
      a.city || a.town || a.village || a.municipality || a.suburb ||
      a.county || a.state_district || a.state || json.name || null;
    // `country` is the full name ("India") — Couriers needs this, not the ISO code, because
    // Serper's place-search silently mis-resolves "Hyderabad, IN" while "Hyderabad, India"
    // works (confirmed empirically; the code form is not a documented rejection, just wrong).
    const result = place
      ? { place, country: (a.country_code || '').toUpperCase() || null, countryName: a.country || null }
      : null;
    cache.set(key, result); // cache misses too — no point asking twice about open sea
    return result;
  } catch {
    return null; // transient; leave uncached so it can be retried
  }
}

/**
 * Resolve names for several locations, spending at most `budgetMs` on ones we have not seen
 * before. Cached entries are free and always returned.
 */
async function reverseGeocodeMany(points, budgetMs = 4500) {
  const out = new Map();
  const unknown = [];

  for (const p of points) {
    if (cache.has(p.key)) out.set(p.key, cache.get(p.key));
    else unknown.push(p);
  }

  const deadline = Date.now() + budgetMs;
  for (const p of unknown) {
    if (Date.now() >= deadline) break; // rest resolve on a later request
    out.set(p.key, await lookup(p.key, p.lat, p.lon));
  }
  return out;
}

module.exports = { reverseGeocodeMany, _cache: cache };
