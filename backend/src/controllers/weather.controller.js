const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { drivingConditions, isConfigured } = require('../services/weather');
const env = require('../config/env');

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
