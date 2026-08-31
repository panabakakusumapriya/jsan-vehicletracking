/**
 * Migrate and rebuild GLOBAL UKM — road counted once for the whole coverage programme.
 *
 *   npm run backfill:global-ukm -- --dry-run     report only; writes NOTHING
 *   npm run backfill:global-ukm                  stamp scopes, then rebuild the default scope
 *   npm run backfill:global-ukm -- --scope HOUSE-CAPTURE-2026
 *   npm run backfill:global-ukm -- --stamp-only  stamp coverage scopes, do not rebuild
 *
 * What it writes
 * --------------
 *   Trip.coverageScopeId / coverageCycleId   stamped where missing, resolved from the trip's
 *                                            project (services/coverageScope.js)
 *   CoverageSegment                          the scope's ledger, cleared and replayed
 *   Trip UKM fields                          ukmStatus, distinctRoadMeters, sameTripRepeatMeters,
 *                                            historicalDuplicateMeters, globalUniqueMeters,
 *                                            unmatchedReviewMeters, ukmUniqueShapes,
 *                                            ukmDuplicateShapes, globalUkmComputedAt
 *
 * What it never touches
 * ---------------------
 *   LocationPoint, RejectedPoint             the raw GPS evidence — recomputing a derived figure
 *                                            must never cost evidence
 *   distanceMeters, cleanedDistanceMeters, cleanedRouteShapes, mapMatchStatus
 *   ukmMeters / ukmWithinTripMeters / ukmNewShapes   the legacy per-driver figures, left intact so
 *                                            old and new can be compared side by side
 *   UkmEdge                                  the legacy collection, left entirely alone
 *
 * Purely local arithmetic over geometry already stored: no Valhalla calls, nothing billable, safe
 * to run at any hour. Idempotent — running it twice produces the same ledger and the same numbers,
 * because ownership is decided by observation time, not by the order this script visits trips.
 *
 * Run it AFTER map-matching has settled. Every figure derives from cleanedRouteShapes, so a trip
 * still being re-matched would be measured against geometry about to be replaced. (The map-match
 * worker notices that case and re-attributes on its own, so a mistimed run self-corrects rather
 * than leaving a wrong number in place — but a settled run is still the cleaner story.)
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Trip = require('../models/Trip');
const CoverageSegment = require('../models/CoverageSegment');
const env = require('../config/env');
const { rebuildScope } = require('../services/globalUkm');
const { scopeForProject } = require('../services/coverageScope');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};

const dryRun = has('--dry-run');
const stampOnly = has('--stamp-only');
const onlyScope = valueOf('--scope');
const cycleId = valueOf('--cycle') || '';

const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(1);

/**
 * Give every closed trip a coverage scope.
 *
 * Trips recorded before the field existed have none, and a trip with no scope is invisible to the
 * engine — which is the dangerous state, not a safe one: the roads it covered stay unclaimed, so
 * the next driver down the same street is credited with new coverage the fleet already has.
 * Resolving them from their project (falling back to the fleet-wide default) is a migration with
 * one obvious right answer, and it is recorded on the trip so it never has to be guessed twice.
 */
async function stampScopes() {
  const missing = await Trip.find({
    status: { $in: ['completed', 'timed_out'] },
    $or: [{ coverageScopeId: null }, { coverageScopeId: { $exists: false } }],
  })
    .select('_id projectId')
    .lean();

  if (!missing.length) {
    log('Coverage scope: every closed trip already carries one.');
    return { stamped: 0, byScope: new Map() };
  }

  const byScope = new Map();
  const ops = [];
  for (const trip of missing) {
    const scope = await scopeForProject(trip.projectId);
    const label = `${scope.coverageScopeId}${scope.coverageCycleId ? `/${scope.coverageCycleId}` : ''}`;
    byScope.set(label, (byScope.get(label) || 0) + 1);
    ops.push({
      updateOne: {
        filter: { _id: trip._id },
        update: {
          $set: {
            coverageScopeId: scope.coverageScopeId,
            coverageCycleId: scope.coverageCycleId,
          },
        },
      },
    });
  }

  log(`Coverage scope: ${missing.length} trip(s) need stamping.`);
  for (const [label, n] of byScope) log(`  ${label.padEnd(28)} ${n}`);

  if (dryRun) return { stamped: 0, byScope };

  for (let i = 0; i < ops.length; i += 1000) {
    await Trip.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  return { stamped: ops.length, byScope };
}

(async () => {
  await connectDB();

  if (!env.GLOBAL_UKM_ENABLED) {
    log('GLOBAL_UKM_ENABLED is false. Set it to true before running this.');
    await mongoose.disconnect();
    return;
  }

  await stampScopes();

  if (stampOnly) {
    log('\n--stamp-only: scopes written, ledger not rebuilt.');
    await mongoose.disconnect();
    return;
  }

  // Every (scope, cycle) pair present in the data — a cycle is a separate ledger, so rebuilding a
  // scope means rebuilding each of its cycles, not merging them into one history.
  const pairs = await Trip.aggregate([
    {
      $match: {
        status: { $in: ['completed', 'timed_out'] },
        coverageScopeId: { $ne: null },
        ...(onlyScope ? { coverageScopeId: onlyScope } : {}),
        ...(cycleId ? { coverageCycleId: cycleId } : {}),
      },
    },
    { $group: { _id: { scope: '$coverageScopeId', cycle: '$coverageCycleId' }, trips: { $sum: 1 } } },
    { $sort: { '_id.scope': 1, '_id.cycle': 1 } },
  ]);
  const scopes = pairs.map((row) => ({
    scopeId: row._id.scope,
    cycleId: row._id.cycle || '',
    trips: row.trips,
  }));

  if (!scopes.length) {
    log('\nNo coverage scopes to rebuild.');
    await mongoose.disconnect();
    return;
  }

  const label = (sc) => `${sc.scopeId}${sc.cycleId ? ` / cycle ${sc.cycleId}` : ''}`;

  if (dryRun) {
    log(`\n--dry-run: nothing written. Would rebuild ${scopes.length} ledger(s):`);
    for (const sc of scopes) {
      const n = await Trip.countDocuments({
        coverageScopeId: sc.scopeId,
        coverageCycleId: sc.cycleId ? sc.cycleId : { $in: [null, ''] },
        status: { $in: ['completed', 'timed_out'] },
        cleanedRouteShapes: { $exists: true, $ne: [] },
      });
      log(`  ${label(sc)}: ${n} of ${sc.trips} trip(s) are matched and would be replayed in observation order`);
    }
    await mongoose.disconnect();
    return;
  }

  for (const sc of scopes) {
    log(`\nRebuilding ${label(sc)} …`);
    const summary = await rebuildScope(sc.scopeId, sc.cycleId, {
      onProgress: ({ phase, done, total }) => log(`  ${phase}: ${done}/${total}`),
    });
    log(`  ${summary.attributed}/${summary.trips} trip(s) attributed`);
    log(`  ${summary.segments.toLocaleString()} road segment(s), ${km(summary.scopeUniqueMeters)} km of unique road here`);
  }

  // Fleet reconciliation. The identity worth checking is not "raw = duplicate + unique" — raw
  // holds GPS noise, idling and self-repeat and never balances — but this one, which the engine
  // guarantees by construction and is therefore worth asserting out loud:
  //     distinct road covered = road already covered by the programme + new road
  const agg = await Trip.aggregate([
    { $match: { globalUniqueMeters: { $ne: null } } },
    { $group: {
      _id: null,
      trips: { $sum: 1 },
      raw: { $sum: '$distanceMeters' },
      cleaned: { $sum: '$cleanedDistanceMeters' },
      distinct: { $sum: '$distinctRoadMeters' },
      repeat: { $sum: '$sameTripRepeatMeters' },
      duplicate: { $sum: '$historicalDuplicateMeters' },
      unique: { $sum: '$globalUniqueMeters' },
      unmatched: { $sum: '$unmatchedReviewMeters' },
      zeroUkm: { $sum: { $cond: [{ $eq: ['$globalUniqueMeters', 0] }, 1, 0] } },
      review: { $sum: { $cond: [{ $eq: ['$ukmStatus', 'review'] }, 1, 0] } },
    } },
  ]);
  const pending = await Trip.countDocuments({
    status: { $in: ['completed', 'timed_out'] },
    globalUniqueMeters: null,
  });

  if (agg.length) {
    const a = agg[0];
    log(`\nFleet totals across ${a.trips} trip(s) with a global figure:`);
    log(`  raw travelled          ${km(a.raw)} km   (GPS trace as recorded)`);
    log(`  cleaned / matched      ${km(a.cleaned)} km   (snapped to road)`);
    log(`  distinct road          ${km(a.distinct)} km   (same-trip repeats removed)`);
    log(`    same-trip repeat     ${km(a.repeat)} km   (driven again inside one trip)`);
    log(`  historical duplicate   ${km(a.duplicate)} km   (already covered by the programme)`);
    log(`  GLOBAL UNIQUE (UKM)    ${km(a.unique)} km   <- the number`);
    log(`  unmatched / review     ${km(a.unmatched)} km   (road identity not established)`);
    const drift = a.distinct - (a.duplicate + a.unique);
    log(`\n  reconciliation: distinct - (duplicate + unique) = ${drift.toFixed(2)} m  ${Math.abs(drift) < 1 ? 'OK' : 'INVESTIGATE'}`);
    log(`  trips with 0 UKM (all previously covered): ${a.zeroUkm}`);
    log(`  trips flagged review (partial map match):  ${a.review}`);
  }
  log(`  trips with NO figure yet (null, not zero):  ${pending}`);

  const ledger = await CoverageSegment.aggregate([
    { $group: {
      _id: { scope: '$coverageScopeId', cycle: '$coverageCycleId' },
      segments: { $sum: 1 },
      meters: { $sum: '$lengthMeters' },
    } },
    { $sort: { '_id.scope': 1, '_id.cycle': 1 } },
  ]);
  if (ledger.length) {
    log('\nCoverage ledger:');
    for (const row of ledger) {
      const name = `${row._id.scope}${row._id.cycle ? ` / ${row._id.cycle}` : ''}`;
      log(`  ${name.padEnd(30)} ${row.segments.toLocaleString()} segments  ${km(row.meters)} km`);
    }
  }

  log('\nRaw GPS, route geometry, raw/cleaned distances and the legacy per-driver UKM figures were not modified.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillGlobalUkm failed:', err);
  process.exit(1);
});
