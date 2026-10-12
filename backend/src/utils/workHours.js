/**
 * The most working time one trip can contribute: 12 hours.
 *
 * Trips are force-closed at 8 hours now (device and server), but sessions from before that limit
 * were left open for days and closed much later — 128 trips of over 24 hours, 31,203 hours between
 * them, against about 6,700 hours for the other 3,100 trips. Counted at face value they made a
 * working-hours total mostly fiction. 12 hours leaves any genuine long day whole.
 */
const WORK_CAP_MS = 12 * 60 * 60 * 1000;

/** Mongo expression: a trip's counted working time (to now while running), capped. */
const workMsExpr = {
  $min: [WORK_CAP_MS, { $max: [0, { $subtract: [{ $ifNull: ['$endedAt', '$$NOW'] }, '$startedAt'] }] }],
};

module.exports = { WORK_CAP_MS, workMsExpr };
