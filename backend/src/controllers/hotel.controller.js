const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { hotelsForDrivers } = require('../services/hotelSearch');

/**
 * GET /api/hotels/near-driver
 *
 * Hotels around a driver's own last reported position. With no `driverId` it picks the first
 * driver we can place, so the page has something real on it the moment it opens.
 *
 * Answered from the imported HotelLocation dataset — see services/hotelLocations.js. There is no
 * external provider behind this any more, so there is no key to be missing, no quota to be spent
 * and no upstream to be down. The dates, price and rating parameters went with it: a directory of
 * buildings has none of those to filter on, and accepting them would promise something we cannot
 * deliver.
 *
 * Query: driverId, radiusKm (1–200), category.
 */
exports.nearDriver = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const q = req.query;

  try {
    const result = await hotelsForDrivers({
      scope,
      driverId: q.driverId || null,
      radiusKm: q.radiusKm,
      category: typeof q.category === 'string' ? q.category : null,
      project: typeof q.project === 'string' ? q.project : null,
    });
    res.json(result);
  } catch (err) {
    // Only our own database can fail now, and that is a real fault rather than an operational
    // fact about someone else's service — so it reads as a 500, not a 502 "upstream is unhappy".
    res.status(err.status || 500).json({
      error: err.message || 'Could not load hotel locations',
      configured: false,
    });
  }
});
