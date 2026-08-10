const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { drivingConditions, isConfigured } = require('../services/weather');
const { classifyWmo, iconFor } = require('../services/weatherCodes');
const { scoreSlot } = require('../services/drivingWeather');
const Trip = require('../models/Trip');
const { reverseGeocodeMany } = require('../services/geocode');
const { gridKey } = require('../services/drivingWeather');
const env = require('../config/env');

const ARCHIVE_HOURLY = [
  'temperature_2m', 'apparent_temperature', 'weather_code',
  'wind_speed_10m', 'wind_gusts_10m', 'visibility',
  'precipitation', 'is_day',
].join(',');

/**
 * GET /api/weather/driving?day=0
 *
 * Driving conditions for every location that has drivers, worst first. `day` is an offset in
 * local days: 0 = today, up to 4 (the forecast covers 5 days). Later days cost no extra API
 * calls — the same response already contains them.
 */
exports.driving = asyncHandler(async (req, res) => {
  const dayOffset = Math.min(Math.max(parseInt(req.query.day || '0', 10) || 0, 0), 4);
  const scope = await accessibleDriverFilter(req.user);

  try {
    const result = await drivingConditions({ scope, dayOffset });
    res.json({
      ...result,
      thresholds: {
        windCautionKmh: env.WEATHER_WIND_CAUTION_KMH,
        gustUnsafeKmh: env.WEATHER_GUST_UNSAFE_KMH,
        activeDays: env.WEATHER_ACTIVE_DAYS,
        cacheMinutes: env.WEATHER_CACHE_MINUTES,
      },
    });
  } catch (err) {
    // A weather outage must not read like a bug in the panel.
    return res.status(err.status || 502).json({
      error: err.message || 'Could not reach the weather service',
      configured: isConfigured(),
    });
  }
});

/**
 * GET /api/weather/trip-history?driverId=&from=&to=&limit=50
 *
 * Fast — returns completed trips instantly (no external API calls).
 * Weather is fetched on demand per trip via GET /api/weather/trip-weather/:id.
 */
exports.tripHistory = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope, status: { $in: ['ended', 'timed_out'] } };
  if (req.query.driverId) filter.driverId = req.query.driverId;
  if (req.query.from || req.query.to) {
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.startedAt.$lte = new Date(`${req.query.to}T23:59:59`);
  }

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const trips = await Trip.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit)
    .populate('driverId', 'name email country project')
    .populate('vehicleId', 'plateNumber');

  const summaries = trips.map(t => tripSummary(t));

  // Resolve place names for trip start locations
  const points = summaries
    .filter(s => s.startLocation?.lat && s.startLocation?.lon)
    .map(s => ({ key: gridKey(s.startLocation.lat, s.startLocation.lon), lat: s.startLocation.lat, lon: s.startLocation.lon }));
  const names = await reverseGeocodeMany(points, 3000);
  for (const s of summaries) {
    if (s.startLocation?.lat && s.startLocation?.lon) {
      const hit = names.get(gridKey(s.startLocation.lat, s.startLocation.lon));
      s.locationName = hit?.place || null;
    } else {
      s.locationName = null;
    }
  }

  res.json({ trips: summaries });
});

/**
 * GET /api/weather/trip-weather/:id
 *
 * Fetches historical weather from Open-Meteo archive API for a single trip.
 * Called on demand when the user expands a trip row in the History tab.
 */
exports.tripWeather = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const trip = await Trip.findOne({ _id: req.params.id, ...scope });
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  const loc = trip.startLocation;
  if (!loc || !loc.lat || !loc.lon || !trip.startedAt) {
    return res.json({ weather: null });
  }

  const dateStr = trip.startedAt.toISOString().slice(0, 10);
  const endDateStr = (trip.endedAt || trip.startedAt).toISOString().slice(0, 10);
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&start_date=${dateStr}&end_date=${endDateStr}` +
    `&hourly=${ARCHIVE_HOURLY}&timezone=auto&timeformat=unixtime&wind_speed_unit=kmh`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return res.json({ weather: null });

  const json = await resp.json();
  const h = json.hourly || {};
  const times = h.time || [];
  const tripStart = trip.startedAt.getTime() / 1000;
  const tripEnd = (trip.endedAt || trip.startedAt).getTime() / 1000;

  const slots = [];
  for (let i = 0; i < times.length; i++) {
    const dt = times[i];
    if (dt < tripStart - 3600 || dt > tripEnd + 3600) continue;
    const code = h.weather_code?.[i];
    const { description, severity } = classifyWmo(code);
    slots.push(scoreSlot({
      dt,
      at: new Date(dt * 1000).toISOString().slice(11, 16),
      tempC: h.temperature_2m?.[i] ?? null,
      feelsLikeC: h.apparent_temperature?.[i] ?? null,
      windKmh: h.wind_speed_10m?.[i] ?? null,
      gustKmh: h.wind_gusts_10m?.[i] ?? null,
      visibilityM: h.visibility?.[i] ?? null,
      precipMm: h.precipitation?.[i] ?? 0,
      popPct: 0,
      severity, description,
      icon: iconFor(code, h.is_day?.[i] !== 0),
    }));
  }

  let verdict = 'clear';
  for (const s of slots) {
    if (s.risk === 'unsafe') { verdict = 'unsafe'; break; }
    if (s.risk === 'caution') verdict = 'caution';
  }

  res.json({ weather: { slots, verdict } });
});

function tripSummary(trip) {
  const driver = trip.driverId && typeof trip.driverId === 'object' ? trip.driverId : null;
  const vehicle = trip.vehicleId && typeof trip.vehicleId === 'object' ? trip.vehicleId : null;
  return {
    _id: trip._id,
    driverId: driver?._id || trip.driverId,
    driverName: driver?.name || 'Unknown',
    driverCountry: driver?.country || null,
    driverProject: driver?.project || null,
    vehiclePlate: vehicle?.plateNumber || null,
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    distanceMeters: trip.distanceMeters || 0,
    maxSpeedKmh: trip.maxSpeedKmh || 0,
    status: trip.status,
    startLocation: trip.startLocation,
    locationName: null,
  };
}
