const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { couriersForDrivers } = require('../services/courierSearch');

/**
 * GET /api/couriers/near-driver
 *
 * Courier/shipping locations (FedEx, DHL, UPS, etc.) around a driver's own last reported
 * position. With no `driverId` it picks the first driver we can place.
 *
 * Answered from the imported CourierLocation dataset — see services/courierLocations.js. There is
 * no external provider behind this any more, so there is no key to be missing, no quota to be
 * spent and no upstream to be down.
 *
 * Query: driverId, radiusKm (1–200).
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
    // Only our own database can fail now, and that is a real fault rather than an operational
    // fact about someone else's service — so it reads as a 500, not a 502 "upstream is unhappy".
    res.status(err.status || 500).json({
      error: err.message || 'Could not load courier locations',
      configured: false,
    });
  }
});
