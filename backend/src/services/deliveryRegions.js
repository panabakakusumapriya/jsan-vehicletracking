const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const { timezoneFromCoords } = require('../utils/tzFromCoords');
const { ZONES } = require('../utils/countryTimezone');

/**
 * Which country a delivery is in — what the coverage page filters and totals by.
 *
 * A delivery's own label cannot do it. Every PRJ-025 import was called "PRJ-025-HE-DRIVE-AUSGNZ
 * network", Victoria, Queensland and the Queensland top-up alike, so "show me Australia" has to
 * come from somewhere other than the name. It comes from the ground: the time zone under the
 * delivery's work areas, which is offline (tz-lookup), free, and never wrong about which side of
 * the Tasman a polygon sits.
 *
 * Detected once and stored on the version (`region`, `regionSource: 'auto'`). A manager can
 * overwrite it from the panel (`regionSource: 'manual'`) — to split a country into states, say —
 * and a manual name is never re-detected over.
 */

/** Zones whose country the zone name alone does not say. Checked before the prefix rules. */
const ZONE_COUNTRY = {
  'Pacific/Auckland': 'New Zealand',
  'Pacific/Chatham': 'New Zealand',
  'Asia/Kolkata': 'India',
  'Asia/Calcutta': 'India',
};
/** Whole families of zones that belong to one country. */
const PREFIX_COUNTRY = [['Australia/', 'Australia']];

const titleCase = (s) =>
  s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap, c) => gap + c.toUpperCase());

/**
 * The reverse of utils/countryTimezone.js: the zone it picked for a country names that country.
 * Only the spelled-out keys ("UNITED KINGDOM", not "UK"/"GB"), so the result reads as a name.
 */
const FROM_TABLE = (() => {
  const out = new Map();
  for (const [key, zone] of Object.entries(ZONES)) {
    if (key.length <= 3 || out.has(zone)) continue;
    out.set(zone, titleCase(key));
  }
  return out;
})();

/** IANA zone → country name. Unknown zones answer with the zone's continent ("Europe"). */
function countryForZone(zone) {
  if (!zone) return null;
  if (ZONE_COUNTRY[zone]) return ZONE_COUNTRY[zone];
  for (const [prefix, country] of PREFIX_COUNTRY) if (zone.startsWith(prefix)) return country;
  if (FROM_TABLE.has(zone)) return FROM_TABLE.get(zone);
  const continent = zone.split('/')[0];
  return continent && continent !== 'Etc' ? continent.replace(/_/g, ' ') : null;
}

/** Areas looked at per delivery. A vote, so a handful of border polygons cannot swing it. */
const SAMPLE = 200;

/** The country most of a delivery's work areas are in, or null when it has none with a position. */
async function detectRegion(versionId) {
  const areas = await WorkArea.find({ networkVersionId: versionId, 'bbox.3': { $exists: true } })
    .select('bbox -_id')
    .limit(SAMPLE)
    .lean();
  const votes = new Map();
  for (const { bbox } of areas) {
    const [w, s, e, n] = bbox;
    const country = countryForZone(timezoneFromCoords((s + n) / 2, (w + e) / 2));
    if (country) votes.set(country, (votes.get(country) || 0) + 1);
  }
  let best = null;
  for (const [country, n] of votes) if (!best || n > votes.get(best)) best = country;
  return best;
}

/**
 * Fill in `region` on any of these versions that has none, writing what was found so it is only
 * ever worked out once. Mutates and returns the given (lean or hydrated) documents.
 */
async function ensureRegions(versions) {
  await Promise.all(
    versions
      .filter((v) => !v.region)
      .map(async (v) => {
        const region = await detectRegion(v._id);
        if (!region) return;
        v.region = region;
        v.regionSource = 'auto';
        // Conditional, so a manager's name saved in the meantime is never overwritten.
        await NetworkVersion.updateOne(
          { _id: v._id, $or: [{ region: null }, { region: { $exists: false } }] },
          { $set: { region, regionSource: 'auto' } }
        );
      })
  );
  return versions;
}

module.exports = { countryForZone, detectRegion, ensureRegions };
