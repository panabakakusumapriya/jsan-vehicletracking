/**
 * Old UKM vs new UKM, side by side. READ-ONLY — this script writes nothing, ever.
 *
 *   npm run compare:ukm                  fleet + per-driver comparison
 *   npm run compare:ukm -- --trips 30    also list the 30 trips that disagree most
 *   npm run compare:ukm -- --driver <id> one driver only
 *
 * Answers the question "did the new logic actually change anything, and where".
 *
 * The three figures being compared
 * --------------------------------
 *   Trip.ukmMeters          OLD. Road not covered by an EARLIER TRIP BY THE SAME DRIVER.
 *                           (services/roadSegments.js — still computed, still stored.)
 *   UkmEdge                 OLDER. Same per-driver idea over raw ~11 m GPS grid cells.
 *                           Kept for reference; its numbers are noisier and not comparable
 *                           metre-for-metre, because it identifies roads differently.
 *   Trip.globalUniqueMeters NEW. Road not covered by ANY earlier trip in the coverage scope —
 *                           any driver, any project. (services/globalUkm.js.)
 *
 * The first and third use the SAME road identity (snapped-polyline segments), so the difference
 * between them is not measurement noise. It is exactly one thing:
 *
 *     old - new = road this driver had not personally driven, but somebody else already had
 *
 * which is the road the old logic paid for twice. If that number is zero, the old logic was not
 * over-crediting anyone — see "Why the numbers may legitimately match" printed at the end.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Trip = require('../models/Trip');
const User = require('../models/User');
const UkmEdge = require('../models/UkmEdge');
const CoverageSegment = require('../models/CoverageSegment');
const env = require('../config/env');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};
const onlyDriver = valueOf('--driver');
const tripRows = parseInt(valueOf('--trips') || '0', 10);

const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(2);
const pad = (v, n) => String(v).padStart(n);
const padEnd = (v, n) => String(v).slice(0, n).padEnd(n);
const rule = (n = 96) => log('─'.repeat(n));

(async () => {
  await connectDB();

  const tripMatch = {
    status: { $in: ['completed', 'timed_out'] },
    ...(onlyDriver ? { driverId: new mongoose.Types.ObjectId(onlyDriver) } : {}),
  };

  // ── 0. Has the new engine actually run? The most common reason for "no difference" ──
  const totalClosed = await Trip.countDocuments(tripMatch);
  const withGeometry = await Trip.countDocuments({
    ...tripMatch,
    cleanedRouteShapes: { $exists: true, $ne: [] },
  });
  const withOld = await Trip.countDocuments({ ...tripMatch, ukmMeters: { $ne: null } });
  const withNew = await Trip.countDocuments({ ...tripMatch, globalUniqueMeters: { $ne: null } });
  const ledgerSegments = await CoverageSegment.estimatedDocumentCount();

  log('\n═══ 1. Has the new engine run? ═══\n');
  log(`  closed trips                       ${pad(totalClosed, 8)}`);
  log(`  ...with snapped geometry           ${pad(withGeometry, 8)}   (only these can have any UKM at all)`);
  log(`  ...with an OLD per-driver figure   ${pad(withOld, 8)}`);
  log(`  ...with a NEW global figure        ${pad(withNew, 8)}`);
  log(`  coverage ledger segments           ${pad(ledgerSegments, 8)}`);

  if (withNew === 0 || ledgerSegments === 0) {
    log('\n  ⚠  The new engine has not attributed anything yet, so every "new" figure below is');
    log('     empty and the page is still showing you the old numbers. Run:');
    log('\n         npm run backfill:global-ukm\n');
    log('     (or wait for the map-match worker, which fills these in a few trips per tick).');
  } else if (withNew < withGeometry) {
    log(`\n  ⚠  ${withGeometry - withNew} matched trip(s) still have no global figure. The comparison`);
    log('     below covers only the ones that do. Run `npm run backfill:global-ukm` to finish.');
  }

  if (!env.GLOBAL_UKM_ENABLED) {
    log('\n  ⚠  GLOBAL_UKM_ENABLED is false — nothing new is being computed at all.');
  }

  // ── 1. The headline: how much road did the old logic credit twice? ──
  // Restricted to trips that have BOTH figures, so this is a like-for-like comparison and not an
  // artefact of one side being further along than the other.
  const both = { ...tripMatch, ukmMeters: { $ne: null }, globalUniqueMeters: { $ne: null } };
  const fleet = await Trip.aggregate([
    { $match: both },
    { $group: {
      _id: null,
      trips: { $sum: 1 },
      raw: { $sum: '$distanceMeters' },
      cleaned: { $sum: '$cleanedDistanceMeters' },
      oldUkm: { $sum: '$ukmMeters' },
      newUkm: { $sum: '$globalUniqueMeters' },
      distinct: { $sum: '$distinctRoadMeters' },
      duplicate: { $sum: '$historicalDuplicateMeters' },
      disagreeing: { $sum: { $cond: [{ $gt: [{ $subtract: ['$ukmMeters', '$globalUniqueMeters'] }, 1] }, 1, 0] } },
    } },
  ]);

  if (!fleet.length) {
    log('\nNo trips carry both an old and a new figure yet — nothing to compare.');
    await mongoose.disconnect();
    return;
  }
  const f = fleet[0];
  const delta = f.oldUkm - f.newUkm;

  log('\n═══ 2. Fleet totals, over the ' + f.trips + ' trip(s) that have BOTH figures ═══\n');
  log(`  raw distance driven                ${pad(km(f.raw), 12)} km`);
  log(`  snapped / cleaned distance         ${pad(km(f.cleaned), 12)} km`);
  log(`  distinct road (repeats removed)    ${pad(km(f.distinct), 12)} km`);
  rule(60);
  log(`  OLD  per-driver UKM                ${pad(km(f.oldUkm), 12)} km`);
  log(`  NEW  global UKM                    ${pad(km(f.newUkm), 12)} km`);
  log(`  DIFFERENCE                         ${pad(km(delta), 12)} km` +
      (f.oldUkm > 0 ? `   (${((delta / f.oldUkm) * 100).toFixed(1)}% of the old figure)` : ''));
  log(`  trips where they disagree          ${pad(f.disagreeing, 12)}  of ${f.trips}`);
  log('');
  log('  The difference is road a driver had not personally driven but someone else already had —');
  log('  exactly what the old per-driver logic credited twice. It cannot be negative: global');
  log('  uniqueness is strictly stricter than per-driver uniqueness.');

  if (delta < -1) {
    log('\n  ⚠  NEGATIVE difference — that should be impossible. Likely causes: the two figures were');
    log('     computed from different geometry (a trip was re-matched between runs), or a scope');
    log('     was rebuilt while trips were still being matched. Re-run backfill:global-ukm.');
  }

  // ── 2. Is there cross-driver overlap in this data at all? ──
  // The direct evidence. If no road was ever driven by two different drivers, the two logics
  // MUST agree, and the new engine is working correctly by returning the same answer.
  const overlap = await CoverageSegment.aggregate([
    { $match: { passes: { $gt: 1 }, lastDriverId: { $ne: null } } },
    { $group: {
      _id: null,
      repeated: { $sum: 1 },
      repeatedMeters: { $sum: '$lengthMeters' },
      crossDriver: { $sum: { $cond: [{ $ne: ['$firstDriverId', '$lastDriverId'] }, 1, 0] } },
      crossDriverMeters: {
        $sum: { $cond: [{ $ne: ['$firstDriverId', '$lastDriverId'] }, '$lengthMeters', 0] },
      },
    } },
  ]);
  const o = overlap[0] || { repeated: 0, repeatedMeters: 0, crossDriver: 0, crossDriverMeters: 0 };

  log('\n═══ 3. Does this fleet actually overlap? ═══\n');
  log(`  road segments driven more than once      ${pad(o.repeated, 10)}   ${pad(km(o.repeatedMeters), 10)} km`);
  log(`  ...where a DIFFERENT driver came back    ${pad(o.crossDriver, 10)}   ${pad(km(o.crossDriverMeters), 10)} km`);
  log('');
  log('  "cross-driver" is a lower bound — it compares only the first and most recent driver on');
  log('  each segment, so a road driven by three crews where the first and last were the same');
  log('  person is not counted here. It is evidence that overlap exists, not a measure of it.');

  // ── 3. Per driver ──
  const byDriver = await Trip.aggregate([
    { $match: both },
    { $group: {
      _id: '$driverId',
      trips: { $sum: 1 },
      raw: { $sum: '$distanceMeters' },
      oldUkm: { $sum: '$ukmMeters' },
      newUkm: { $sum: '$globalUniqueMeters' },
    } },
    { $sort: { newUkm: -1 } },
  ]);
  const drivers = new Map(
    (await User.find({ _id: { $in: byDriver.map((d) => d._id) } }).select('name project').lean())
      .map((u) => [String(u._id), u])
  );
  const edges = await UkmEdge.aggregate([
    { $match: { driverId: { $in: byDriver.map((d) => d._id) } } },
    { $group: { _id: '$driverId', meters: { $sum: '$distanceMeters' } } },
  ]);
  const edgeByDriver = new Map(edges.map((e) => [String(e._id), e.meters]));

  log('\n═══ 4. Per driver ═══\n');
  log(`  ${padEnd('Driver', 24)} ${pad('Trips', 6)} ${pad('Raw km', 10)} ${pad('OLD ukm', 10)} ${pad('NEW ukm', 10)} ${pad('Lost km', 10)}  ${pad('UkmEdge*', 10)}`);
  rule(96);
  for (const row of byDriver) {
    const u = drivers.get(String(row._id));
    const lost = row.oldUkm - row.newUkm;
    log(
      `  ${padEnd(u?.name || String(row._id), 24)} ${pad(row.trips, 6)} ${pad(km(row.raw), 10)} ` +
      `${pad(km(row.oldUkm), 10)} ${pad(km(row.newUkm), 10)} ${pad(km(lost), 10)}  ` +
      `${pad(km(edgeByDriver.get(String(row._id)) || 0), 10)}`
    );
  }
  rule(96);
  log('  * UkmEdge is the oldest implementation and uses raw ~11 m GPS grid cells, not snapped');
  log('    road geometry. It is shown for reference only — it is NOT comparable metre-for-metre');
  log('    with the other two columns, and it is a LIFETIME total, not a total for these trips.');
  log('    "Lost km" = OLD - NEW: road this driver was credited with that the fleet already had.');

  // ── 4. The trips that disagree most ──
  if (tripRows > 0) {
    const worst = await Trip.aggregate([
      { $match: both },
      { $addFields: { lost: { $subtract: ['$ukmMeters', '$globalUniqueMeters'] } } },
      { $match: { lost: { $gt: 1 } } },
      { $sort: { lost: -1 } },
      { $limit: tripRows },
      { $project: {
        startedAt: 1, driverId: 1, distanceMeters: 1, ukmMeters: 1,
        globalUniqueMeters: 1, historicalDuplicateMeters: 1, lost: 1, ukmStatus: 1,
      } },
    ]);
    const names = new Map(
      (await User.find({ _id: { $in: worst.map((t) => t.driverId) } }).select('name').lean())
        .map((u) => [String(u._id), u.name])
    );

    log(`\n═══ 5. The ${worst.length} trip(s) where the two logics disagree most ═══\n`);
    if (!worst.length) {
      log('  None. Every trip gets the same answer under both logics.');
    } else {
      log(`  ${padEnd('Date', 11)} ${padEnd('Driver', 20)} ${pad('OLD', 9)} ${pad('NEW', 9)} ${pad('Lost', 9)}  Trip id`);
      rule(96);
      for (const t of worst) {
        log(
          `  ${padEnd(new Date(t.startedAt).toISOString().slice(0, 10), 11)} ` +
          `${padEnd(names.get(String(t.driverId)) || '?', 20)} ` +
          `${pad(km(t.ukmMeters), 9)} ${pad(km(t.globalUniqueMeters), 9)} ${pad(km(t.lost), 9)}  ${t._id}`
        );
      }
      log('\n  Open any of these at /trips/<id> — the UKM tile shows the global figure with a');
      log('  "global" badge, and "Already covered" beside it is the road the fleet already had.');
    }
  } else {
    log('\n  (Run with `-- --trips 30` to list the individual trips that disagree.)');
  }

  // ── 5. If nothing moved, say why that can be correct ──
  if (delta <= 1) {
    log('\n═══ Why the numbers may legitimately match ═══\n');
    log('  A zero difference is a real, valid result — it does not mean the new logic is not');
    log('  running. It means no driver was ever credited for road another driver had already');
    log('  covered. That is exactly what you would expect when:');
    log('');
    log('    • drivers work disjoint areas, so their routes never overlap. This is the usual');
    log(`      reason, and section 3 above is the check: ${o.crossDriver} segment(s) show a second`);
    log('      driver returning to road someone else had already driven.');
    log('    • the date range or fleet is small enough that two crews have not met yet.');
    log('    • the overlap exists but has not been attributed yet — check section 1.');
    log('');
    log('  The difference appears the moment two drivers cover the same street. To prove the');
    log('  mechanism works without waiting for that, run `npm run test:global-ukm`, which drives');
    log('  the cross-driver, cross-project and nested-overlap cases directly.');
  }

  log('\nNothing was written. This script only reads.\n');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('compareUkm failed:', err);
  process.exit(1);
});
