const Trip = require('../models/Trip');

/**
 * The one rule for WHICH unique-km figure a driver is measured on:
 *
 *   polygon(s) assigned during the trip -> assigned-route UKM (linkUkmMeters, services/linkCoverage.js)
 *   no polygon                          -> global UKM        (globalUniqueMeters, services/globalUkm.js)
 *
 * `ukmBasis` is written ONLY by the link-coverage pass — it is the one that knows about
 * assignments — and stays null until that pass has run. This module never persists a basis of its
 * own: the global engine runs first, and having it stamp 'global' would label an assigned driver's
 * trip as unassigned for the seconds (or, with the worker off, the hours) until the link pass
 * caught up. A null basis is READ as global — the figure the trip is measured on so far — so
 * `effectiveUkmMeters` is always defined by the same rule wherever it is consumed.
 *
 * Both engines call syncEffectiveUkm after writing their own number, so whichever finishes last,
 * the copy is right. Reports, the phone and the trip page then read a single field.
 */
function effectiveUkm(trip) {
  const meters = trip.ukmBasis === 'assigned' ? trip.linkUkmMeters : trip.globalUniqueMeters;
  // null stays null: "not established" must never be rendered as zero.
  return { effectiveUkmMeters: meters == null ? null : meters };
}

async function syncEffectiveUkm(tripId) {
  const trip = await Trip.findById(tripId).select('ukmBasis linkUkmMeters globalUniqueMeters').lean();
  if (!trip) return null;
  const next = effectiveUkm(trip);
  await Trip.updateOne({ _id: tripId }, { $set: next });
  return { ukmBasis: trip.ukmBasis || null, ...next };
}

module.exports = { effectiveUkm, syncEffectiveUkm };
