const env = require('../config/env');
const Trip = require('../models/Trip');
const User = require('../models/User');
const { isValidTimeZone, formatDateInZone } = require('../utils/timezone');
const { searchByCoordinates, isConfigured, budgetStatus } = require('./bookingHotels');

/**
 * "Where can this driver sleep tonight?"
 *
 * The location is never asked for — it is the driver's own last reported position, the same
 * source the live map and the weather tab use. A manager should not be typing a town name for
 * someone whose coordinates we already have.
 *
 * ONE SEARCH PER REQUEST, ON PURPOSE. The weather tab fans out across every location on load
 * because Open-Meteo is free; Booking.com through RapidAPI is metered per call, so this looks
 * up hotels for the ONE driver being viewed. Fanning out over a 13-driver fleet would spend a
 * month of a small plan in an afternoon.
 */

/** Latest known position per driver, newest trip wins. Mirrors the weather tab's lookup. */
async function recentDriverPositions(scope, activeDays) {
  const cutoff = new Date(Date.now() - activeDays * 86400_000);
  const rows = await Trip.aggregate([
    { $match: { ...scope, lastLocation: { $ne: null }, startedAt: { $gte: cutoff } } },
    { $sort: { startedAt: -1 } },
    {
      $group: {
        _id: '$driverId',
        lat: { $first: '$lastLocation.lat' },
        lon: { $first: '$lastLocation.lon' },
        at: { $first: '$lastLocation.recordedAt' },
        // The device reports its own timezone, which beats guessing one from coordinates.
        timezone: { $first: '$timezone' },
      },
    },
  ]);
  return rows.filter((r) => typeof r.lat === 'number' && typeof r.lon === 'number');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const utcToday = () => new Date().toISOString().slice(0, 10);

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400_000);
}

/**
 * Today's date as the DRIVER reads it.
 *
 * A manager in Melbourne checking on a driver in Andhra Pradesh must not book "tonight" a day
 * late. The device timezone is used when we have it; otherwise longitude is a decent stand-in
 * (15° ≈ 1 hour), which picks the right calendar date except within an hour of midnight.
 */
function driverLocalToday(position) {
  if (isValidTimeZone(position?.timezone)) return formatDateInZone(new Date(), position.timezone);
  const offsetHours = Math.round((position?.lon ?? 0) / 15);
  return new Date(Date.now() + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Default stay: tonight, one night. Clamped so arrival is never before the UTC date, because
 * a past arrival_date is one of the things the provider rejects outright.
 */
function defaultDates(position) {
  const arrival = [driverLocalToday(position), utcToday()].sort().pop(); // the later of the two
  return { arrival, departure: addDays(arrival, 1) };
}

function validateDates(arrival, departure, position) {
  const fallback = defaultDates(position);
  const from = ISO_DATE.test(arrival || '') ? arrival : fallback.arrival;
  let to = ISO_DATE.test(departure || '') ? departure : addDays(from, 1);

  if (from < utcToday()) {
    const e = new Error('Check-in cannot be in the past.');
    e.status = 400;
    throw e;
  }
  if (daysBetween(from, to) < 1) to = addDays(from, 1);
  if (daysBetween(from, to) > env.HOTELS_MAX_NIGHTS) to = addDays(from, env.HOTELS_MAX_NIGHTS);

  return { arrival: from, departure: to, nights: daysBetween(from, to) };
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const SORTS = {
  distance: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
  price: (a, b) => (a.perNight?.value ?? 1e9) - (b.perNight?.value ?? 1e9),
  rating: (a, b) => (b.score ?? -1) - (a.score ?? -1),
};

/**
 * The whole page in one request: who the manager can pick, where the chosen driver is, and
 * the properties around them.
 */
async function hotelsForDrivers(opts) {
  const {
    scope, driverId = null,
    arrival = null, departure = null,
    adults = 1, rooms = 1, childrenAge = '',
    radiusKm = env.HOTELS_DEFAULT_RADIUS_KM,
    currency = env.HOTELS_CURRENCY,
    page = 1, sort = 'distance',
    freeParkingOnly = false, minScore = 0,
  } = opts;

  const driverFilter = { role: 'user', active: true };
  if (scope.driverId) driverFilter._id = scope.driverId;
  const drivers = await User.find(driverFilter).select('name email country project').sort({ name: 1 });

  const positions = await recentDriverPositions(scope, env.HOTELS_ACTIVE_DAYS);
  const positionById = new Map(positions.map((p) => [String(p._id), p]));

  // Everyone the manager could search for, each carrying whether we can place them.
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
      timezone: pos?.timezone || null,
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
      properties: [],
      totalFound: 0,
      // No position means no search — and no paid call for a question we cannot ask.
      message: drivers.length
        ? `No driver has reported a position in the last ${env.HOTELS_ACTIVE_DAYS} days, so there is nowhere to search around.`
        : 'No active drivers to search for.',
    };
  }

  const dates = validateDates(arrival, departure, chosen);
  const search = {
    arrival: dates.arrival,
    departure: dates.departure,
    nights: dates.nights,
    adults: clamp(parseInt(adults, 10) || 1, 1, 30),
    rooms: clamp(parseInt(rooms, 10) || 1, 1, 30),
    // Provider accepts 10–500 km; anything outside that is a validation error, not a filter.
    radiusKm: clamp(parseInt(radiusKm, 10) || env.HOTELS_DEFAULT_RADIUS_KM, 10, 500),
    currency: /^[A-Z]{3}$/.test(String(currency).toUpperCase()) ? String(currency).toUpperCase() : env.HOTELS_CURRENCY,
    childrenAge: /^\d{1,2}(,\d{1,2})*$/.test(childrenAge) ? childrenAge : '',
    page: clamp(parseInt(page, 10) || 1, 1, 20),
    sort: SORTS[sort] ? sort : 'distance',
  };

  const result = await searchByCoordinates({
    lat: chosen.lat,
    lon: chosen.lon,
    nights: search.nights,
    ...search,
  });

  let properties = result.properties;
  // The provider's radius is generous — it returned properties 60 km out on a 30 km search —
  // so the computed distance is what actually enforces "near the driver".
  properties = properties.filter((p) => p.distanceKm == null || p.distanceKm <= search.radiusKm);
  if (freeParkingOnly) properties = properties.filter((p) => p.freeParking);
  if (minScore > 0) properties = properties.filter((p) => (p.score ?? 0) >= minScore);
  properties.sort(SORTS[search.sort]);

  return {
    ...base,
    budget: budgetStatus(),
    selected: {
      _id: chosen._id,
      name: chosen.name,
      lat: chosen.lat,
      lon: chosen.lon,
      lastSeenAt: chosen.lastSeenAt,
      timezone: chosen.timezone,
      country: chosen.country,
      project: chosen.project,
    },
    search,
    properties,
    totalFound: result.totalFound,
    shown: properties.length,
    fromCache: result.fromCache,
    cachedAgeSeconds: result.cachedAgeSeconds,
  };
}

module.exports = {
  hotelsForDrivers,
  // exported for tests
  defaultDates,
  validateDates,
  driverLocalToday,
  addDays,
  daysBetween,
  SORTS,
};
