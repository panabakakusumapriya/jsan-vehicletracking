/**
 * Rebuild ASSIGNED-NETWORK coverage — the LinkCoverage ledger and the per-trip in/out-of-area and
 * assigned-route UKM figures — for every active network version.
 *
 *   npm run backfill:link-coverage -- --dry-run          report only; writes NOTHING
 *   npm run backfill:link-coverage                       rebuild every active version
 *   npm run backfill:link-coverage -- --version <id>     one version
 *
 * Run it after activating a network for a project that already has trips, and after any change to
 * LINK_COVER_* / AREA_BOUNDARY_BUFFER_METERS. The map-match worker attributes NEW trips on its own;
 * this is for history.
 *
 * What it writes: LinkCoverage rows for the version (cleared and replayed), and on each trip
 * assignedAreaIds, assignedNetworkVersionId, inAreaMeters, outAreaMeters, outAreaShapes,
 * linkUkmMeters, linkUkmNetworkMeters, linkUkmShapes, linkCoveredCount, linkCoverageStatus,
 * linkCoverageComputedAt, ukmBasis, effectiveUkmMeters.
 *
 * What it never touches: raw GPS, route geometry, raw/cleaned distances, the global-UKM ledger
 * (CoverageSegment) and figures, the per-driver UKM figures. Pure local arithmetic, nothing
 * billable, idempotent — ownership is decided by observation time, not by visit order.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const NetworkVersion = require('../models/NetworkVersion');
const LinkCoverage = require('../models/LinkCoverage');
const Trip = require('../models/Trip');
const env = require('../config/env');
const { rebuildNetworkCoverage } = require('../services/linkCoverage');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};
const dryRun = has('--dry-run');
const onlyVersion = valueOf('--version');
const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(1);

(async () => {
  await connectDB();

  if (!env.LINK_COVERAGE_ENABLED) {
    log('LINK_COVERAGE_ENABLED is false. Set it to true before running this.');
    await mongoose.disconnect();
    return;
  }

  const filter = { status: 'active', ...(onlyVersion ? { _id: onlyVersion } : {}) };
  const versions = await NetworkVersion.find(filter).populate('projectId', 'name').lean();
  if (!versions.length) {
    log('No active network version to rebuild.');
    await mongoose.disconnect();
    return;
  }

  for (const v of versions) {
    const label = `${v.projectId?.name || v.projectId} / ${v.label}`;
    const before = await LinkCoverage.countDocuments({ networkVersionId: v._id });
    if (dryRun) {
      const trips = await Trip.countDocuments({
        status: { $in: ['completed', 'timed_out'] },
        mapMatchStatus: 'matched',
        projectId: v.projectId?._id || v.projectId,
      });
      log(`--dry-run ${label}: ${before} covered link(s) now; ${trips} matched trip(s) stamped with the project would be replayed`);
      continue;
    }
    log(`\nRebuilding ${label} (${before} covered link(s) before) …`);
    const summary = await rebuildNetworkCoverage(v._id, {
      onProgress: ({ phase, done, total }) => log(`  ${phase}: ${done}/${total}`),
    });
    log(`  ${summary.attributed}/${summary.trips} trip(s) attributed`);
    log(`  ${summary.coveredLinks.toLocaleString()} link(s) covered, ${km(summary.coveredMeters)} km of ${km(v.targetMeters)} km target`);
  }

  if (!dryRun) {
    const agg = await Trip.aggregate([
      { $match: { linkCoverageStatus: { $in: ['computed', 'review'] } } },
      {
        $group: {
          _id: '$ukmBasis',
          trips: { $sum: 1 },
          inArea: { $sum: '$inAreaMeters' },
          outArea: { $sum: '$outAreaMeters' },
          assignedUkm: { $sum: '$linkUkmMeters' },
          networkUkm: { $sum: '$linkUkmNetworkMeters' },
          effective: { $sum: '$effectiveUkmMeters' },
        },
      },
    ]);
    log('\nPer-trip totals by UKM basis:');
    for (const row of agg) {
      log(`  ${String(row._id).padEnd(9)} ${row.trips} trip(s)  in-area ${km(row.inArea)} km  outside ${km(row.outArea)} km  assigned UKM ${km(row.assignedUkm)} km  network UKM ${km(row.networkUkm)} km  effective UKM ${km(row.effective)} km`);
    }
    log('\nRaw GPS, route geometry, global UKM and per-driver UKM figures were not modified.');
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillLinkCoverage failed:', err);
  process.exit(1);
});
