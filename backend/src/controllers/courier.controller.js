const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { couriersForDrivers } = require('../services/courierSearch');
const { isConfigured, budgetStatus } = require('../services/serperCouriers');

/**
 * GET /api/couriers/near-driver
 *
 * Courier/shipping locations (FedEx, DHL, UPS, etc.) around a driver's own last reported
 * position. With no `driverId` it picks the first driver we can place.
 *
 * Query: driverId, radiusKm (5–100).
 */
exports.nearDriver = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const q = req.query;

  try {
    const result = await couriersForDrivers({
      scope,
      driverId: q.driverId || null,
      radiusKm: q.radiusKm,
    });
    res.json(result);
  } catch (err) {
    // A provider outage, a spent quota or a missing key are operational facts about the
    // courier feed — none of them should read like the panel is broken.
    res.status(err.status || 502).json({
      error: err.message || 'Could not reach the courier-location service',
      configured: isConfigured(),
      budget: budgetStatus(),
    });
  }
});
