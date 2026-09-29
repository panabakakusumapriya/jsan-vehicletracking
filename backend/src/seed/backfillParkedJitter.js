/**
 * Parked-GPS jitter backfill — classify closed history, then give back the road it never drove.
 *
 *   npm run backfill:parked-jitter -- --dry-run     report what WOULD change; writes NOTHING
 *   npm run backfill:parked-jitter                  classify trips that carry no verdict yet
 *   npm run backfill:parked-jitter -- --reclassify  re-decide every closed trip (after a re-tune)
 *   npm run backfill:parked-jitter -- --trip <id>   one trip; spot checks and incident work
 *
 * Thresholds come from the environment, so a re-tune runs like:
 *   PARKED_JITTER_NET_MAX_METERS=150 PARKED_JITTER_SPREAD_MAX_METERS=400 \
 *     npm run backfill:parked-jitter -- --reclassify
 *
 * The rule itself lives in services/tripNoise.js; this script only replays it over history and
 * settles what the new verdicts move.
 *
 * What it writes
 * --------------
 *   Trip.parkedJitter / parkedJitterAt / parkedJitterMeters / parkedJitterSpreadMeters
 *   CoverageSegment                  rebuilt for every (scope, cycle) a changed verdict touches
 *   LinkCoverage                     rebuilt for every active network version one touches
 *   Trip UKM fields                  recomputed by those rebuilds — a flagged trip's figures go
 *                                    null, and trips that had been "duplicate" against its claims
 *                                    are re-measured
 *   Trip per-driver UKM              recomputed per affected driver (roadSegments.recomputeDriverUkm)
 *
 * What it never touches: raw GPS (LocationPoint), route geometry, raw/cleaned distances,
 * mapMatchStatus — and every trip whose verdict did not change.
 *
 * Why the rebuilds are needed: a jitter session used to claim road while it was eligible, so one
 * parking spot's drift could hold a street that a later REAL trip then read as "already covered".
 * Flipping the flag alone would leave that street owned by a session that never moved, so the
 * affected ledgers are cleared and replayed, skipping ineligible trips. Attribution is a pure
 * function of stored geometry and observation order — the replay is idempotent, and safe to
 * re-run.
 *
 * Run it after map-matching has settled on the range being rebuilt. Classification itself needs
 * only the raw points and is independent of the matcher.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const NetworkVersion = require('../models/NetworkVersion');
const User = require('../models/User');
const env = require('../config/env');
const { featuresFromPoints, verdictFields } = require('../services/tripNoise');
const { rebuildScope } = require('../services/globalUkm');
const { rebuildNetworkCoverage } = require('../services/linkCoverage');
const { recomputeDriverUkm } = require('../services/roadSegments');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};
const dryRun = has('--dry-run');
const reclassify = has('--reclassify');
const onlyTrip = valueOf('--trip');
const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(1);

// Trips per point-fetch round trip. The { tripId, recordedAt } index serves the $in batch, so one
// query per 200 trips replaces 200, and peak memory stays at one batch's traces.
const FETCH_BATCH = 200;

(async () => {
  await connectDB();

  // verdictFields consults the kill switch: with the classifier off it would stamp "not jitter"
  // over every trip it sees — including a correct earlier verdict. Refuse to run at all.
  if (!env.PARKED_JITTER_ENABLED) {
    log('PARKED_JITTER_ENABLED is false — stamping verdicts now would mark every trip "not jitter". Enable it and rerun.');
    await mongoose.disconnect();
    return;
  }

  const filter = { status: { $in: ['completed', 'timed_out'] } };
  if (onlyTrip) {
    filter._id = onlyTrip;
  } else if (!reclassify) {
    // verdictFields ALWAYS writes parkedJitterAt with a verdict, so a null (or absent) one is
    // exactly "nobody has decided this trip". Unclassified is not the same as "not jitter": those
    // trips were eligible all along and are left untouched.
    filter.parkedJitterAt = null;
  }

  const trips = await Trip.find(filter)
    .select('_id driverId projectId distanceMeters parkedJitter parkedJitterAt coverageScopeId coverageCycleId')
    .sort({ startedAt: 1, _id: 1 })
    .lean();

  if (!trips.length) {
    log(onlyTrip ? 'Trip not found.' : 'Nothing to classify — every closed trip already carries a verdict.');
    await mongoose.disconnect();
    return;
  }
  log(
    `${trips.length} closed trip(s) to classify` +
      (reclassify && !onlyTrip ? ' (reclassify: verdicts recomputed even where one exists)' : '') +
      (dryRun ? ' — dry run, nothing will be written' : '')
  );

  /* ---- Phase 1: replay the rule over history ---- */

  const changed = []; // verdict flipped — these need their coverage settled again
  let kept = 0; // classified now, not jitter (or was already)
  let noVerdict = 0; // fewer than two fixes — nothing to decide, stays unclassified

  const now = new Date();
  for (let i = 0; i < trips.length; i += FETCH_BATCH) {
    const batch = trips.slice(i, i + FETCH_BATCH);
    const points = await LocationPoint.find({ tripId: { $in: batch.map((t) => t._id) } })
      .select('tripId lat lon recordedAt')
      .sort({ tripId: 1, recordedAt: 1 })
      .lean();
    const byTrip = new Map();
    for (const p of points) {
      const key = String(p.tripId);
      if (!byTrip.has(key)) byTrip.set(key, []);
      byTrip.get(key).push(p);
    }

    const ops = [];
    for (const trip of batch) {
      const fields = verdictFields(featuresFromPoints(byTrip.get(String(trip._id)) || []));
      if (!fields) {
        noVerdict += 1;
        continue;
      }
      // A verdict is stamped in both directions: a trip cleared by a re-tune was previously
      // excluded and has to be let back in, so both flips are changes.
      const flipped = fields.parkedJitter !== (trip.parkedJitter === true);
      if (flipped) changed.push({ trip, flagged: fields.parkedJitter });
      else kept += 1;
      ops.push({
        updateOne: {
          filter: { _id: trip._id },
          update: { $set: { ...fields, parkedJitterAt: now } },
        },
      });
    }
    if (!dryRun && ops.length) await Trip.bulkWrite(ops, { ordered: false });
    if (!dryRun) log(`  classified ${Math.min(i + FETCH_BATCH, trips.length)}/${trips.length} …`);
  }

  const flaggedNow = changed.filter((c) => c.flagged);
  const unflaggedNow = changed.filter((c) => !c.flagged);
  const flaggedMeters = flaggedNow.reduce((t, c) => t + (c.trip.distanceMeters || 0), 0);

  log('');
  log(`  newly flagged as parked jitter : ${flaggedNow.length}  (${km(flaggedMeters)} km of GPS drift)`);
  log(`  previously flagged, now clean  : ${unflaggedNow.length}`);
  log(`  classified, no change          : ${kept}`);
  log(`  undecidable (fewer than 2 fixes, left unclassified): ${noVerdict}`);

  if (!changed.length) {
    log('\nNo verdict changed — nothing to re-attribute.');
    await mongoose.disconnect();
    return;
  }

  /* ---- Phase 2: settle what the changed verdicts move ---- */

  const changeSet = changed.map((c) => c.trip);
  const driverIds = [...new Set(changeSet.map((t) => String(t.driverId)))];
  const scopePairs = [
    ...new Map(
      changeSet
        .filter((t) => t.coverageScopeId)
        .map((t) => [`${t.coverageScopeId}|${t.coverageCycleId || ''}`, { scopeId: t.coverageScopeId, cycleId: t.coverageCycleId || '' }])
    ).values(),
  ];
  const unstamped = changeSet.filter((t) => !t.coverageScopeId).length;

  if (dryRun) {
    log(`\n--dry-run: nothing written. Would recompute per-driver UKM for ${driverIds.length} driver(s),`);
    log(`  rebuild ${scopePairs.length} global coverage ledger(s), and rebuild the active network version(s)`);
    log(`  of the affected project(s). (${unstamped} changed trip(s) carry no coverage scope — the global`);
    log('  engine never saw them; run backfill:global-ukm first if that is unexpected.)');
    await mongoose.disconnect();
    return;
  }

  for (const driverId of driverIds) {
    await recomputeDriverUkm(driverId);
  }
  log(`\nPer-driver UKM recomputed for ${driverIds.length} driver(s).`);

  if (env.GLOBAL_UKM_ENABLED && scopePairs.length) {
    for (const sc of scopePairs) {
      log(`Rebuilding global scope ${sc.scopeId}${sc.cycleId ? ` / cycle ${sc.cycleId}` : ''} …`);
      const summary = await rebuildScope(sc.scopeId, sc.cycleId, {
        onProgress: ({ phase, done, total }) => log(`  ${phase}: ${done}/${total}`),
      });
      log(`  ${summary.attributed}/${summary.trips} trip(s) attributed, ${km(summary.scopeUniqueMeters)} km unique here`);
    }
  } else if (!env.GLOBAL_UKM_ENABLED) {
    log('GLOBAL_UKM_ENABLED is false — global coverage ledgers not rebuilt (nothing was ever claimed).');
  }

  // Which ACTIVE versions could hold a claim from a changed trip: the projects stamped on those
  // trips, plus the projects of their drivers (a legacy trip carries no project but is attributed
  // through its driver's membership — the same rule rebuildNetworkCoverage uses).
  const projectIds = new Set(changeSet.map((t) => (t.projectId ? String(t.projectId) : null)).filter(Boolean));
  const drivers = await User.find({ _id: { $in: driverIds } }).select('projectIds').lean();
  for (const d of drivers) for (const pid of d.projectIds || []) projectIds.add(String(pid));

  if (env.LINK_COVERAGE_ENABLED && projectIds.size) {
    const versions = await NetworkVersion.find({ status: 'active', projectId: { $in: [...projectIds] } })
      .populate('projectId', 'name')
      .lean();
    if (!versions.length) log('No active network version for the affected project(s) — no link ledger to rebuild.');
    for (const v of versions) {
      log(`Rebuilding network coverage ${v.projectId?.name || v.projectId} / ${v.label} …`);
      const summary = await rebuildNetworkCoverage(v._id, {
        onProgress: ({ phase, done, total }) => log(`  ${phase}: ${done}/${total}`),
      });
      log(`  ${summary.attributed}/${summary.trips} trip(s) attributed, ${summary.coveredLinks.toLocaleString()} link(s) covered`);
    }
  } else if (!env.LINK_COVERAGE_ENABLED) {
    log('LINK_COVERAGE_ENABLED is false — link ledgers not rebuilt (nothing was ever claimed).');
  }

  /* ---- Phase 3: where the fleet stands now ---- */

  const [flagged, pending, dist] = await Promise.all([
    Trip.countDocuments({ status: { $in: ['completed', 'timed_out'] }, parkedJitter: true }),
    Trip.countDocuments({ status: { $in: ['completed', 'timed_out'] }, parkedJitterAt: null }),
    Trip.aggregate([
      { $match: { status: { $in: ['completed', 'timed_out'] }, parkedJitter: true } },
      { $group: { _id: null, meters: { $sum: '$distanceMeters' } } },
    ]),
  ]);

  log('\nFleet now:');
  log(`  trips flagged parked jitter: ${flagged.toLocaleString()}  (${km(dist[0]?.meters || 0)} km excluded from coverage and reports)`);
  log(`  closed trips with no verdict: ${pending.toLocaleString()}  (mostly no-GPS imports and 1-fix sessions)`);
  log('\nRaw GPS, route geometry, raw/cleaned distances and mapMatchStatus were not modified.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillParkedJitter failed:', err);
  process.exit(1);
});
