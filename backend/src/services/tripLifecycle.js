const Trip = require('../models/Trip');
const env = require('../config/env');

/**
 * Close active trips that have gone silent for longer than SESSION_DEAD_AFTER_SECONDS.
 *
 * An active trip with no heartbeat for that long isn't live — it's a leftover (app killed,
 * crashed/reinstalled session, or a very long signal loss). Closing it stops it showing up
 * as a permanent "stale" marker on the live map. Offline-buffered points that arrive later
 * still append to the (now closed) trip, so the recorded route is preserved.
 *
 * `extraFilter` narrows the sweep to the drivers a requester may see; the background
 * watchdog passes nothing and sweeps the whole fleet.
 */
async function closeDeadTrips(extraFilter = {}) {
  const deadCutoff = new Date(Date.now() - env.SESSION_DEAD_AFTER_SECONDS * 1000);
  const res = await Trip.updateMany(
    {
      status: 'active',
      ...extraFilter,
      $or: [
        { 'lastLocation.recordedAt': { $lt: deadCutoff } },
        { lastLocation: null, startedAt: { $lt: deadCutoff } },
      ],
    },
    { $set: { status: 'timed_out', endedAt: new Date() } }
  );
  return res.modifiedCount || 0;
}

module.exports = { closeDeadTrips };
