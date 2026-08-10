const Trip = require('../models/Trip');

/**
 * Latest known position per driver, newest trip wins. Shared by every feature anchored to
 * "where is this driver right now" — the live map, Weather, Hotels, Couriers.
 */
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

module.exports = { recentDriverPositions };
