const env = require('../config/env');
const User = require('../models/User');
const { recentDriverPositions } = require('../utils/driverPositions');
const { reverseGeocodeMany } = require('./geocode');
const { gridKey } = require('./drivingWeather');
const { searchNearby, isConfigured, budgetStatus } = require('./serperCouriers');

/**
 * "Where's the nearest FedEx/DHL/UPS-type drop-off to this driver?"
 *
 * Same anchor as Hotels: the driver's own last reported position, never a typed-in town.
 * Also one search per request for the same reason — Serper is metered, and its free tier is
 * a one-time allowance rather than a monthly reset, so fanning this out across a whole fleet
 * on page load would be worse here than it would be for Hotels.
 *
 * Serper's Places search has no working coordinate parameter (see serperCouriers.js), so this
 * has an extra hop Hotels doesn't need: reverse-geocode the driver's lat/lon into a place name
 * first, via the same free Nominatim lookup the Weather tab already uses.
 */
const DEFAULT_QUERY = 'courier OR parcel OR shipping OR FedEx OR DHL OR UPS';

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

async function couriersForDrivers(opts) {
  const { scope, driverId = null, radiusKm = env.COURIER_DEFAULT_RADIUS_KM } = opts;

  const driverFilter = { role: 'user', active: true };
  if (scope.driverId) driverFilter._id = scope.driverId;
  const drivers = await User.find(driverFilter).select('name email country project').sort({ name: 1 });

  const positions = await recentDriverPositions(scope, env.COURIER_ACTIVE_DAYS);
  const positionById = new Map(positions.map((p) => [String(p._id), p]));

  const roster = drivers.map((d) => {
    const pos = positionById.get(String(d._id));
    return {
      _id: d._id,
      name: d.name,
      country: d.country || null,
      project: d.project || null,
      located: Boolean(pos),
      lat: pos?.lat ?? null,
      lon: pos?.lon ?? null,
      lastSeenAt: pos?.at ?? null,
    };
  });

  const locatable = roster.filter((d) => d.located);
  const chosen =
    (driverId && locatable.find((d) => String(d._id) === String(driverId))) || locatable[0] || null;

  const base = {
    configured: isConfigured(),
    drivers: roster,
    unplaced: roster.filter((d) => !d.located).map(({ _id, name, country, project }) => ({ _id, name, country, project })),
    budget: budgetStatus(),
  };

  if (!chosen) {
    return {
      ...base,
      selected: null,
      search: null,
      places: [],
      totalFound: 0,
      message: drivers.length
        ? `No driver has reported a position in the last ${env.COURIER_ACTIVE_DAYS} days, so there is nowhere to search around.`
        : 'No active drivers to search for.',
    };
  }

  const search = {
    radiusKm: clamp(parseInt(radiusKm, 10) || env.COURIER_DEFAULT_RADIUS_KM, 5, 100),
    query: DEFAULT_QUERY,
  };

  // Reverse-geocode first — Serper needs a place name, not coordinates (see serperCouriers.js
  // header). This lookup is itself cached forever by geocode.js, so repeat searches near the
  // same spot cost nothing extra here.
  const gKey = gridKey(chosen.lat, chosen.lon, env.COURIER_GRID_DEGREES);
  const names = await reverseGeocodeMany([{ key: gKey, lat: chosen.lat, lon: chosen.lon }]);
  const place = names.get(gKey);

  if (!place) {
    return {
      ...base,
      selected: {
        _id: chosen._id, name: chosen.name, lat: chosen.lat, lon: chosen.lon,
        lastSeenAt: chosen.lastSeenAt, country: chosen.country, project: chosen.project,
      },
      search: null,
      places: [],
      totalFound: 0,
      message: 'Could not determine a place name for this location yet — try again shortly.',
    };
  }

  // Full country name required — "Hyderabad, IN" silently mis-resolves in Serper while
  // "Hyderabad, India" works (see serperCouriers.js header).
  const locationName = place.countryName ? `${place.place}, ${place.countryName}` : place.place;

  const result = await searchNearby({
    lat: chosen.lat,
    lon: chosen.lon,
    locationName,
    query: search.query,
  });

  let places = result.places;
  // Same as Hotels: the provider's own notion of "near" is generous, so computed distance is
  // what actually enforces the radius the manager asked for.
  places = places.filter((p) => p.distanceKm == null || p.distanceKm <= search.radiusKm);
  places.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

  return {
    ...base,
    budget: budgetStatus(),
    selected: {
      _id: chosen._id, name: chosen.name, lat: chosen.lat, lon: chosen.lon,
      lastSeenAt: chosen.lastSeenAt, country: chosen.country, project: chosen.project,
    },
    search: { ...search, locationName },
    places,
    totalFound: result.totalFound,
    shown: places.length,
    fromCache: result.fromCache,
    cachedAgeSeconds: result.cachedAgeSeconds,
  };
}

module.exports = { couriersForDrivers, DEFAULT_QUERY };
