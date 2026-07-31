const tzLookup = require('tz-lookup');

/**
 * Coordinates → IANA timezone, offline.
 *
 * The position is the honest source. A handset's own timezone can be days behind reality or
 * pinned to the driver's home country while they work abroad, and a country code cannot
 * resolve a zone at all where a country spans several — Australia has five, so the same "AU"
 * covers Perth, Brisbane and Melbourne, which are three different clocks.
 *
 * tz-lookup carries the timezone boundaries in-process: no key, no network, no per-call cost,
 * so this can run on every trip without thinking about it.
 */
function timezoneFromCoords(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  // Exact 0,0 is a failed GPS fix, not the Gulf of Guinea. Returning Etc/GMT for it would
  // dress a broken reading up as a real location — the fleet already has one driver sitting
  // there. No zone is the truthful answer.
  if (Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001) return null;

  try {
    return tzLookup(lat, lon) || null;
  } catch {
    return null;
  }
}

module.exports = { timezoneFromCoords };
