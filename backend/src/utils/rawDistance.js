const env = require('../config/env');
const { haversineMeters } = require('./geo');

/**
 * Raw (un-snapped) distance between consecutive GPS fixes, with the anomalies a phone produces
 * thrown out before they become kilometres.
 *
 * Why: ingest used to add the straight line between ANY two fixes more than 5 m apart. A phone
 * sitting under a roof can report fixes hundreds of metres apart, two phones on one account
 * interleave their positions, and an offline backlog can arrive out of order — each of those read
 * as driving. On the worst days a driver's raw km came out at four to five times their map-matched
 * km (Ali Azhar, Joel Howells, Aug–Sep 2026). The matched ("cleaned") distance never had the
 * problem, because the matcher drops what no road explains; this gives the raw figure the same
 * discipline, so the two agree to within GPS noise.
 *
 * A step from the previous fix to this one counts only when the phone could have driven it:
 *   - later in time than the previous fix (a duplicate or out-of-order fix is not travel);
 *   - within RAW_MAX_GAP_MS of it — across a longer silence the straight line is not road, it is
 *     wherever the phone was carried to while it was off;
 *   - both fixes at least as accurate as RAW_MAX_ACCURACY_M — a 200 m error circle is not a position;
 *   - at least RAW_MIN_STEP_M long, so a parked phone's jitter does not add up;
 *   - and at no more than RAW_MAX_SPEED_KMH — faster than that it is a teleport, not a drive.
 *
 * The chain always advances to the newest fix whether or not its step counted, so a single bad fix
 * costs at most the two small steps either side of it, never the rest of the trip.
 *
 * Used by ingest for every point that lands, and by seed/backfillRawDistance.js to recompute trips
 * recorded before this existed. The device applies a similar guard before uploading
 * (MAX_PLAUSIBLE_SPEED_KMH in TrackingService.kt); this is the server's own, so an old build or a
 * second phone cannot get around it.
 */
const RAW_MAX_SPEED_KMH = env.RAW_MAX_SPEED_KMH ?? 160;
const RAW_MAX_GAP_MS = (env.RAW_MAX_GAP_MINUTES ?? 15) * 60 * 1000;
const RAW_MAX_ACCURACY_M = env.RAW_MAX_ACCURACY_M ?? 50;
const RAW_MIN_STEP_M = 5;

const tooInaccurate = (p) => Number.isFinite(p.accuracy) && p.accuracy > RAW_MAX_ACCURACY_M;

/**
 * Metres to credit for the step prev → cur, or 0 when the step is an anomaly.
 * Both are { lat, lon, recordedAt: Date, accuracy?: number }. prev may be null (first fix).
 */
function stepMeters(prev, cur) {
  if (!prev || !cur) return 0;
  const t0 = prev.recordedAt instanceof Date ? prev.recordedAt.getTime() : new Date(prev.recordedAt).getTime();
  const t1 = cur.recordedAt instanceof Date ? cur.recordedAt.getTime() : new Date(cur.recordedAt).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 0;
  const dt = t1 - t0;
  if (dt <= 0 || dt > RAW_MAX_GAP_MS) return 0;
  if (tooInaccurate(prev) || tooInaccurate(cur)) return 0;
  const d = haversineMeters(prev, cur);
  if (d < RAW_MIN_STEP_M) return 0;
  if ((d / 1000) / (dt / 3600000) > RAW_MAX_SPEED_KMH) return 0;
  return d;
}

/** Total credited metres over fixes already sorted by recordedAt. */
function sumMeters(points) {
  let total = 0;
  let prev = null;
  for (const p of points) {
    total += stepMeters(prev, p);
    prev = p;
  }
  return total;
}

module.exports = { stepMeters, sumMeters, RAW_MAX_SPEED_KMH, RAW_MAX_GAP_MS, RAW_MAX_ACCURACY_M, RAW_MIN_STEP_M };
