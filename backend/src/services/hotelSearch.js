const env = require('../config/env');
const User = require('../models/User');
const { recentDriverPositions } = require('../utils/driverPositions');
const { nearbyHotels, datasetStatus } = require('./hotelLocations');

// Search imported accommodation around one accessible driver at a time.

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * The whole page in one request: who the manager can pick, where the chosen driver is, and
 * the properties around them.
 */
async function hotelsForDrivers(opts) {
  const { scope, driverId = null, radiusKm = env.HOTELS_DEFAULT_RADIUS_KM, category = null, project = null } = opts;

  const driverFilter = { role: 'user', active: true };
  if (scope.driverId) driverFilter._id = scope.driverId;
  const drivers = await User.find(driverFilter).select('name email country project').sort({ name: 1 });

  const positions = await recentDriverPositions(scope, null);
  const now = Date.now();
  const cutoff = now - 48 * 60 * 60 * 1000;
  const positionById = new Map(positions.filter(p => {
    const recordedAt = p.at ? new Date(p.at).getTime() : NaN;
    return recordedAt >= cutoff && recordedAt <= now;
  }).map(p => [String(p._id), p]));

  // Everyone the manager could search for, each carrying whether we can place them.
  const projects = [...new Set(drivers.map(d => d.project).filter(Boolean))].sort();
  const roster = drivers.filter(d => positionById.has(String(d._id)) && (!project || d.project === project)).map((d) => {
    const pos = positionById.get(String(d._id));
    return {
      _id: d._id,
      name: d.name,
      country: d.country || null,
      project: d.project || null,
      located: Boolean(pos),
      stale: Boolean(pos && (!pos.at || new Date(pos.at).getTime() < Date.now() - env.HOTELS_ACTIVE_DAYS * 86400_000)),
      lat: pos?.lat ?? null,
      lon: pos?.lon ?? null,
      lastSeenAt: pos?.at ?? null,
      timezone: pos?.timezone || null,
    };
  });

  const locatable = roster.filter((d) => d.located);
  const chosen =
    (driverId && locatable.find((d) => String(d._id) === String(driverId))) || locatable[0] || null;

  const dataset = await datasetStatus();

  const base = {
    // Nothing to configure any more — there is no key and no quota. Kept in the response so the
    // page's existing "not set up" branch stays wired rather than becoming dead code that rots.
    configured: dataset.total > 0,
    dataset,
    projects,
    drivers: roster,
    unplaced: roster.filter((d) => !d.located).map(({ _id, name, country, project }) => ({ _id, name, country, project })),
  };

  if (!dataset.total) {
    return {
      ...base,
      selected: null,
      search: null,
      properties: [],
      totalFound: 0,
      message: 'No hotels have been imported yet. Run `npm run import:hotels` to load them.',
    };
  }

  if (!chosen) {
    return {
      ...base,
      selected: null,
      search: null,
      properties: [],
      totalFound: 0,
      message: roster.length
        ? 'No driver in this selection has reported a position yet.'
        : 'No drivers have reported a position in the last 48 hours in this selection.',
    };
  }

  // Keep the radius within the database lookup's supported range.
  const radius = clamp(parseInt(radiusKm, 10) || env.HOTELS_DEFAULT_RADIUS_KM, 1, 200);
  const selected = {
    _id: chosen._id, name: chosen.name, lat: chosen.lat, lon: chosen.lon,
    lastSeenAt: chosen.lastSeenAt, timezone: chosen.timezone,
    country: chosen.country, project: chosen.project, stale: chosen.stale,
  };

  const result = await nearbyHotels({
    lat: chosen.lat,
    lon: chosen.lon,
    radiusKm: radius,
    limit: env.HOTELS_MAX_RESULTS,
    category,
  });

  // Use the nearest imported property's city; hotel searches require only the database.
  const locationName = result.places.find(place => place.city)?.city || null;

  return {
    ...base,
    selected,
    search: { radiusKm: radius, locationName, category: category || null, project },
    properties: result.places,
    totalFound: result.totalFound,
    shown: result.places.length,
    // Coverage is not uniform across a worldwide snapshot. An empty result in a thin region means
    // "we do not hold this area", which is a completely different thing from "there is nowhere to
    // stay" — and the manager has to be able to tell them apart.
    message: result.places.length
      ? null
      : `No accommodation within ${radius} km in our dataset. A blank result may mean the area is `
        + 'not covered rather than genuinely empty — try a wider radius.',
  };
}

module.exports = { hotelsForDrivers };
