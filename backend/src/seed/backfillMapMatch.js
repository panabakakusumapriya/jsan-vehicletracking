/**
 * Re-queue already-matched trips so the map-matcher snaps them again.
 *
 *   node src/seed/backfillMapMatch.js --dry-run     preview; writes NOTHING
 *   node src/seed/backfillMapMatch.js                apply
 *   node src/seed/backfillMapMatch.js --since 2026-07-01
 *   node src/seed/backfillMapMatch.js --include-failed
 *
 * Why this exists: matching happens exactly once per trip. processTrip() claims off
 * `mapMatchStatus: 'pending'` and sets it to 'matched' on success, so a trip already carrying a
 * bad snapped route is never reconsidered — a matcher fix silently applies only to trips
 * completed after the deploy. This resets the status so the existing background worker picks
 * them up again on its normal sweep; it does not call Valhalla itself.
 *
 * Run it after changing anything that alters matched geometry — the U-turn fix that dropped
 * per-point timestamps and widened the candidate search radius being the reason it was written
 * (see MAP_MATCH_SEND_TIMESTAMPS / MAP_MATCH_SEARCH_RADIUS in config/env.js).
 *
 * Safe: touches only the cleaned layer. Raw `distanceMeters` and the recorded LocationPoints are
 * never modified, so a re-match that fails or matches worse costs the snapped overlay, never the
 * trip's real recorded data. Re-running is harmless — trips still queued are already pending.
 *
 * Trips whose LocationPoints no longer exist are skipped outright, and this matters more than it
 * sounds. `Trip.pointCount` is a stored counter, not a live count, so a trip can advertise
 * thousands of points while the collection holds none — that is exactly the state 233 trips were
 * found in after points older than 2026-08-04 were bulk-deleted outside the app. Re-queueing such
 * a trip would clear its existing cleanedRouteShapes and then fail to rebuild them (matchTrace
 * needs >= 2 points), turning a trip that still had a drawable snapped route into one with no
 * geometry at all. The probe below is what stops this script from finishing that job.
 *
 * 'skipped' trips are left alone: they were skipped for being under
 * MAP_MATCH_MIN_DISTANCE_METERS, which no matcher tuning changes. 'failed' trips are left alone
 * too unless --include-failed, since a trace Valhalla genuinely could not match will usually
 * just fail again and spend a request doing it.
 *
 * Pacing is the worker's, not this script's: it re-queues everything at once, and the matcher
 * works through the backlog at MAP_MATCH_MAX_PER_TICK per tick against the shared community
 * server. Expect a large backfill to take a while, and prefer --since to keep it bounded.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const env = require('../config/env');

const dryRun = process.argv.includes('--dry-run');
const includeFailed = process.argv.includes('--include-failed');

const sinceIdx = process.argv.indexOf('--since');
const sinceRaw = sinceIdx !== -1 ? process.argv[sinceIdx + 1] : null;
const since = sinceRaw ? new Date(sinceRaw) : null;
if (sinceRaw && Number.isNaN(since.getTime())) {
  console.error(`--since: "${sinceRaw}" is not a date I can parse (try 2026-07-01).`);
  process.exit(1);
}

const log = (...a) => console.log(...a);

(async () => {
  await connectDB();

  const statuses = includeFailed ? ['matched', 'failed'] : ['matched'];
  const filter = {
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: { $in: statuses },
  };
  if (since) filter.endedAt = { $gte: since };

  log(`Re-queueing trips with mapMatchStatus in [${statuses.join(', ')}]${since ? ` ended on/after ${since.toISOString()}` : ''}.`);

  const candidates = await Trip.find(filter)
    .select('_id endedAt distanceMeters cleanedDistanceMeters cleanedRouteShapes pointCount')
    .sort({ endedAt: -1 });
  log(`${candidates.length} trip(s) match that filter.`);

  if (!candidates.length) {
    log('Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Probe rather than count: limit(2) on the {tripId, recordedAt} index answers "could this be
  // re-matched at all" by reading at most two documents, instead of counting thousands per trip.
  const eligible = [];
  const pointless = [];
  for (const t of candidates) {
    const probe = await LocationPoint.find({ tripId: t._id }).select('_id').limit(2).lean();
    (probe.length >= 2 ? eligible : pointless).push(t);
  }

  if (pointless.length) {
    const stillDrawable = pointless.filter((t) => t.cleanedRouteShapes && t.cleanedRouteShapes.length).length;
    log(`\n${pointless.length} trip(s) SKIPPED — fewer than 2 LocationPoints survive, so they cannot be re-matched.`);
    log('  Their stored pointCount says otherwise; that is a counter on the trip, not a live count.');
    if (stillDrawable) {
      log(`  ${stillDrawable} of them still hold a snapped route that is now their ONLY geometry — left untouched on purpose.`);
    }
  }

  log(`\n${eligible.length} trip(s) will be re-queued.`);
  if (!eligible.length) {
    log('Nothing to re-queue.');
    await mongoose.disconnect();
    return;
  }

  if (!env.VALHALLA_ENABLED) {
    log('\nNote: VALHALLA_ENABLED is false, so the worker will not process the queue until it is on.');
  }

  if (dryRun) {
    log('\nMost recent 5 that would be re-queued:');
    eligible.slice(0, 5).forEach((t) => log(`  ${t._id}  ended ${t.endedAt ? t.endedAt.toISOString() : '(none)'}  raw ${Math.round(t.distanceMeters || 0)} m  cleaned ${t.cleanedDistanceMeters == null ? '(none)' : `${Math.round(t.cleanedDistanceMeters)} m`}`));
    log('\n--dry-run: nothing written.');
    await mongoose.disconnect();
    return;
  }

  // Clear the stale cleaned layer along with the status. Leaving the old distance/shapes in
  // place would let the admin panel keep drawing the U-turn-less route (and quoting its
  // distance) for the whole time the trip sits in the queue waiting to be re-matched. Safe only
  // because every id here was just proven to still have points to rebuild from.
  const res = await Trip.updateMany(
    { _id: { $in: eligible.map((t) => t._id) } },
    {
      $set: {
        mapMatchStatus: 'pending',
        cleanedDistanceMeters: null,
        mapMatchError: null,
        mapMatchedAt: null,
      },
      $unset: { cleanedRouteShapes: 1 },
    }
  );

  const perTick = env.MAP_MATCH_MAX_PER_TICK;
  const ticks = Math.ceil(res.modifiedCount / Math.max(1, perTick));
  const mins = Math.round((ticks * env.MAP_MATCH_INTERVAL_SECONDS) / 60);
  log(`\nDone — ${res.modifiedCount} trip(s) re-queued.`);
  log(`At ${perTick} per ${env.MAP_MATCH_INTERVAL_SECONDS}s tick that is roughly ${mins} minute(s) of matcher work.`);
  log('Raw distanceMeters and recorded points were not touched.');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillMapMatch failed:', err);
  process.exit(1);
});
