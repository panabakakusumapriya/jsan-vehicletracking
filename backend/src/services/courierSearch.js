const env = require('../config/env');
const User = require('../models/User');
const { recentDriverPositions } = require('../utils/driverPositions');
const { reverseGeocodeMany } = require('./geocode');
const { gridKey } = require('./drivingWeather');
const { nearbyCouriers, datasetStatus } = require('./courierLocations');

/**
 * "Where's the nearest FedEx/DHL/UPS-type drop-off to this driver?"
 *
 * Same anchor as Hotels: the driver's own last reported position, never a typed-in town.
 *
 * Now answered from our own CourierLocation collection (68k drop-off points across 167 countries,
 * imported from carriers_world.geojson) rather than Serper's metered Places API. Three things
 * that were true of the old path and are simply not true any more:
 *
 *   - It cost money. Serper's free tier is a ONE-TIME 2,500-query bucket, not a monthly reset, so
 *     every search spent a slice of a permanent allowance. Hence the daily cap and the budget
 *     readout on the page. A $geoNear costs nothing, so both are gone.
 *   - It needed a place NAME. Serper's coordinate parameter does not work (see the header of
 *     serperCouriers.js), so the driver's lat/lon had to be reverse-geocoded through Nominatim
 *     first, and if that failed the manager got no results at all. The database takes coordinates
 *     directly; the place name is now decoration and its failure costs nothing.
 *   - It could be down. This cannot.
 *
 * serperCouriers.js is left in the tree, unused. It documents provider behaviour that was
 * expensive to work out and would be needed again if the live search ever comes back as a
 * fallback for the thin parts of the dataset — see the coverage note in the no-results branch.
 */

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

  const dataset = await datasetStatus();

  const base = {
    // Nothing to configure any more — there is no key and no quota. Kept in the response so the
    // page's existing "not set up" branch stays wired rather than becoming dead code that rots.
    configured: dataset.total > 0,
    dataset,
    drivers: roster,
    unplaced: roster.filter((d) => !d.located).map(({ _id, name, country, project }) => ({ _id, name, country, project })),
  };

  if (!dataset.total) {
    return {
      ...base,
      selected: null,
      search: null,
      places: [],
      totalFound: 0,
      message: 'No courier locations have been imported yet. Run `npm run import:couriers` to load them.',
    };
  }

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

  const radius = clamp(parseInt(radiusKm, 10) || env.COURIER_DEFAULT_RADIUS_KM, 1, 200);
  const selected = {
    _id: chosen._id, name: chosen.name, lat: chosen.lat, lon: chosen.lon,
    lastSeenAt: chosen.lastSeenAt, country: chosen.country, project: chosen.project,
  };

  const result = await nearbyCouriers({
    lat: chosen.lat,
    lon: chosen.lon,
    radiusKm: radius,
    limit: env.COURIER_MAX_RESULTS,
  });

  // A human label for "near where?", nothing more. It used to determine the search itself and a
  // failure meant no results; now it is cosmetic, so it is best-effort and never fatal.
  let locationName = null;
  try {
    const gKey = gridKey(chosen.lat, chosen.lon, env.COURIER_GRID_DEGREES);
    const place = (await reverseGeocodeMany([{ key: gKey, lat: chosen.lat, lon: chosen.lon }])).get(gKey);
    if (place) locationName = place.countryName ? `${place.place}, ${place.countryName}` : place.place;
  } catch {
    // Nominatim being slow or unreachable must not cost the manager their results.
  }

  return {
    ...base,
    selected,
    search: { radiusKm: radius, locationName },
    places: result.places,
    totalFound: result.totalFound,
    shown: result.places.length,
    // Coverage is not uniform: 43k of the 68k points are in North America and 22k in Europe,
    // against 114 in the whole of Africa. An empty result in a thin region means "we do not hold
    // this area", which is a completely different thing from "there is nothing there" — and the
    // manager has to be able to tell them apart before concluding a driver has nowhere to post.
    message: result.places.length
      ? null
      : `No drop-off points within ${radius} km in our dataset. Coverage is strongest in North America and Europe; `
        + 'a blank result elsewhere may mean the area is not covered rather than genuinely empty.',
  };
}

module.exports = { couriersForDrivers };
