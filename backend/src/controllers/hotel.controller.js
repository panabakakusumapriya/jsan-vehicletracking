const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { hotelsForDrivers } = require('../services/hotelSearch');
const { isConfigured, budgetStatus } = require('../services/bookingHotels');

/**
 * GET /api/hotels/near-driver
 *
 * Hotels around a driver's own last reported position. With no `driverId` it picks the first
 * driver we can place, so the page has something real on it the moment it opens.
 *
 * Query: driverId, arrival, departure (YYYY-MM-DD), adults, rooms, childrenAge ("0,17"),
 *        radiusKm (10–500), currency (ISO 4217), page, sort (distance|price|rating),
 *        freeParkingOnly (true|1), minScore.
 */
exports.nearDriver = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const q = req.query;

  try {
    const result = await hotelsForDrivers({
      scope,
      driverId: q.driverId || null,
      arrival: q.arrival || null,
      departure: q.departure || null,
      adults: q.adults,
      rooms: q.rooms,
      childrenAge: q.childrenAge || '',
      radiusKm: q.radiusKm,
      currency: q.currency,
      page: q.page,
      sort: q.sort,
      freeParkingOnly: q.freeParkingOnly === 'true' || q.freeParkingOnly === '1',
      minScore: parseFloat(q.minScore) || 0,
    });
    res.json(result);
  } catch (err) {
    // A provider outage, a spent quota or a missing key are all operational facts about the
    // hotel feed — none of them should read like the panel is broken.
    res.status(err.status || 502).json({
      error: err.message || 'Could not reach the hotel service',
      configured: isConfigured(),
      budget: budgetStatus(),
    });
  }
});
