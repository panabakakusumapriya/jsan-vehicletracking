/**
 * Everything the trip pipeline derives from a trip's points, back to "not worked out yet".
 *
 * Used when a trip's points change after it was processed: ingest reviving a timed-out trip that
 * is still collecting points, and repairs that move points between trips. One list, so a field
 * added to the pipeline cannot be reset in one place and left stale in another.
 *
 * Why each group goes back to pending rather than zero:
 *  - snapped route: describes only the old point set; re-matched when the trip next closes.
 *  - per-driver and global UKM: derived from that geometry. 'pending', not 0 — 0 would claim the
 *    trip covered no new road.
 *  - assigned-network figures: a live trip must not carry an in/out-of-area split or a UKM frozen
 *    from before.
 *  - parked-jitter verdict: it described a closed point set; a stale flag would hide a real drive.
 */
const PIPELINE_RESET_SET = Object.freeze({
  mapMatchStatus: 'pending',
  cleanedDistanceMeters: null,
  cleanedMatchedRatio: null,
  ukmMeters: null,
  ukmWithinTripMeters: null,
  ukmStatus: 'pending',
  distinctRoadMeters: null,
  sameTripRepeatMeters: null,
  historicalDuplicateMeters: null,
  globalUniqueMeters: null,
  unmatchedReviewMeters: null,
  globalUkmComputedAt: null,
  linkCoverageStatus: 'pending',
  linkCoverageComputedAt: null,
  inAreaMeters: null,
  outAreaMeters: null,
  linkUkmMeters: null,
  linkUkmNetworkMeters: null,
  linkCoveredCount: null,
  effectiveUkmMeters: null,
  parkedJitter: false,
  parkedJitterAt: null,
  parkedJitterMeters: null,
  parkedJitterSpreadMeters: null,
});

const PIPELINE_RESET_UNSET = Object.freeze({
  cleanedRouteShapes: 1,
  ukmNewShapes: 1,
  ukmUniqueShapes: 1,
  ukmDuplicateShapes: 1,
  outAreaShapes: 1,
  linkUkmShapes: 1,
});

module.exports = { PIPELINE_RESET_SET, PIPELINE_RESET_UNSET };
