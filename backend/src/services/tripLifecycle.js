const Trip = require('../models/Trip');
const env = require('../config/env');
const { computeTripUkm } = require('./ukmCompute');

/**
 * Close active trips that have gone silent for longer than SESSION_DEAD_AFTER_SECONDS.
 */
async function closeDeadTrips(extraFilter = {}) {
  const deadCutoff = new Date(Date.now() - env.SESSION_DEAD_AFTER_SECONDS * 1000);
  const filter = {
    status: 'active',
    ...extraFilter,
    $or: [
      { 'lastLocation.recordedAt': { $lt: deadCutoff } },
      { lastLocation: null, startedAt: { $lt: deadCutoff } },
    ],
  };

  // Find the trips that will be closed so we can compute UKM for each.
  const toClose = await Trip.find(filter).select('_id driverId').lean();

  if (!toClose.length) return 0;

  const res = await Trip.updateMany(
    { _id: { $in: toClose.map(t => t._id) } },
    { $set: { status: 'timed_out', endedAt: new Date() } }
  );

  // Fire-and-forget UKM computation for each closed trip.
  for (const t of toClose) {
    computeTripUkm(t._id, t.driverId).catch(() => {});
  }

  return res.modifiedCount || 0;
}

module.exports = { closeDeadTrips };
