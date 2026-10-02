const { KIND_RANK } = require('./areaSplit');

/**
 * The names of the places inside a bounding box, from OpenStreetMap.
 *
 * areaSplit cuts a too-big work area into zones and names each zone after the suburbs in it; this
 * is where it learns what the suburbs are called and where they are. OSM maps a suburb as a
 * point (`place=suburb`, with `quarter`, `neighbourhood`, `village`... for the smaller and the
 * rural ones), which is all that is needed: the roads decide where one suburb ends and the next
 * begins, not a line somebody drew.
 *
 * Asked of the public Overpass API. That is somebody else's server, shared and rate-limited, so:
 * one request per area, a short timeout, a second mirror to fall back on — and a failure is NOT
 * an error. The caller gets an empty list and the zones are numbered instead of named. An import
 * must not fail because a map server in Germany is busy.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
/** A manager is waiting on a preview while this runs: give up on a server fairly quickly. */
const TIMEOUT_MS = 25_000;
/** Overpass answers 406 to a request with no User-Agent. */
const USER_AGENT = 'jsan-vehicletracking/1.0 (work-area zoning)';
/** A box bigger than this is not one town: ~330 km a side. Refused rather than hammering the API. */
const MAX_BOX_DEGREES = 3;

function hasLatin(text) {
  return /[A-Za-z]/.test(text);
}

/** Overpass JSON -> [{ name, kind, lon, lat }], de-duplicated and in a stable order. */
function parsePlaces(payload) {
  const out = [];
  const seen = new Set();
  for (const el of payload?.elements || []) {
    const tags = el.tags || {};
    const kind = tags.place;
    if (!(kind in KIND_RANK)) continue;
    // The local name, unless it is in a script the panel's users cannot read and OSM has an
    // English one.
    let name = String(tags.name || '').trim();
    if ((!name || !hasLatin(name)) && tags['name:en']) name = String(tags['name:en']).trim();
    if (!name) continue;
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const key = `${name.toLowerCase()}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.slice(0, 60), kind, lon, lat });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.lon - b.lon || a.lat - b.lat);
  return out;
}

/**
 * @param bbox [west, south, east, north]
 * @returns { places, source } — `source` is 'osm', or the reason there are none
 */
async function fetchPlaces(bbox, { fetchImpl = globalThis.fetch, endpoints = ENDPOINTS, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    return { places: [], source: 'no bounding box' };
  }
  const [w, s, e, n] = bbox;
  if (e - w > MAX_BOX_DEGREES || n - s > MAX_BOX_DEGREES) return { places: [], source: 'area too large to look up' };
  if (typeof fetchImpl !== 'function') return { places: [], source: 'no HTTP client' };

  const kinds = Object.keys(KIND_RANK).join('|');
  const box = `${s},${w},${n},${e}`;
  const query =
    `[out:json][timeout:${Math.round(timeoutMs / 1000)}];` +
    `(node["place"~"^(${kinds})$"](${box});` +
    `way["place"~"^(${kinds})$"](${box});` +
    `relation["place"~"^(${kinds})$"](${box}););out center tags;`;

  let lastError = 'no endpoint answered';
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const places = parsePlaces(await res.json());
      return { places, source: 'osm' };
    } catch (err) {
      lastError = err?.name === 'AbortError' ? 'timed out' : err?.message || 'request failed';
    } finally {
      clearTimeout(timer);
    }
  }
  return { places: [], source: `OpenStreetMap lookup failed (${lastError})` };
}

module.exports = { fetchPlaces, parsePlaces };
