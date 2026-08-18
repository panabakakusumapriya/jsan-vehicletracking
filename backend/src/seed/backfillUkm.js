/**
 * Compute per-trip UKM (unique kilometers) for every driver already in the database.
 *
 *   node src/seed/backfillUniqueRoads.js --dry-run    report only; writes NOTHING
 *   node src/seed/backfillUniqueRoads.js              apply
 *   node src/seed/backfillUniqueRoads.js --driver <id>
 *
 * Purely local: reads each trip's stored snapped route and does arithmetic. No Valhalla calls, so
 * it costs nothing against the community server and is safe to run any time.
 *
 * Run it AFTER map-matching has settled. The figures are derived from `cleanedRouteShapes`, so a
 * trip whose geometry is still being rewritten would be measured against soon-to-be-stale roads.
 * Re-running is free and idempotent (see recomputeDriverUkm), so if in doubt, run it again
 * once matching is finished rather than trying to time it precisely.
 *
 * Touches only ukmMeters / ukmWithinTripMeters / ukmComputedAt. Raw distance,
 * cleaned distance, route geometry and location points are all left exactly as they are.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Trip = require('../models/Trip');
const { recomputeDriverUkm } = require('../services/roadSegments');

const dryRun = process.argv.includes('--dry-run');
const driverIdx = process.argv.indexOf('--driver');
const onlyDriver = driverIdx !== -1 ? process.argv[driverIdx + 1] : null;

const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(1);

(async () => {
  await connectDB();

  const match = { status: { $in: ['completed', 'timed_out'] }, cleanedRouteShapes: { $exists: true, $ne: [] } };
  if (onlyDriver) match.driverId = new mongoose.Types.ObjectId(onlyDriver);

  const driverIds = await Trip.distinct('driverId', match);
  const matchedTrips = await Trip.countDocuments(match);
  log(`${matchedTrips} matched trip(s) across ${driverIds.length} driver(s).`);

  if (dryRun) {
    log('\n--dry-run: nothing written. Recompute is per driver, oldest trip first.');
    await mongoose.disconnect();
    return;
  }

  let done = 0;
  let totalTrips = 0;
  for (const driverId of driverIds) {
    try {
      totalTrips += await recomputeDriverUkm(driverId);
      done += 1;
      if (done % 10 === 0) log(`  ${done}/${driverIds.length} drivers done`);
    } catch (err) {
      log(`  ! driver ${driverId} failed: ${err.message}`);
    }
  }

  const agg = await Trip.aggregate([
    { $match: { ukmMeters: { $ne: null } } },
    { $group: {
      _id: null,
      trips: { $sum: 1 },
      newRoad: { $sum: '$ukmMeters' },
      distinct: { $sum: '$ukmWithinTripMeters' },
      cleaned: { $sum: '$cleanedDistanceMeters' },
      raw: { $sum: '$distanceMeters' },
      allRepeated: { $sum: { $cond: [{ $lt: ['$ukmMeters', 50] }, 1, 0] } },
    } },
  ]);

  log(`\nDone — ${done} driver(s), ${totalTrips} trip(s) updated.`);
  if (agg.length) {
    const a = agg[0];
    log(`\nFleet totals across ${a.trips} trips with a figure:`);
    log(`  raw distance       ${km(a.raw)} km   (GPS trace as recorded)`);
    log(`  snapped distance   ${km(a.cleaned)} km   (GPS noise removed)`);
    log(`  UKM within trips   ${km(a.distinct)} km   (repeats inside each trip removed)`);
    log(`  UKM                ${km(a.newRoad)} km   (also excluding roads driven on an earlier trip)`);
    log(`  trips with 0 UKM (all previously driven): ${a.allRepeated}`);
  }
  log('\nRaw and cleaned distances were not modified.');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillUniqueRoads failed:', err);
  process.exit(1);
});
