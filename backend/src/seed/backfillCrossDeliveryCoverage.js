/**
 * Re-attribute recorded trips so each claims its roads in every live delivery its route reaches.
 *
 * Until linkCoverage.analyseTrip learned to (2026-10-19), a trip claimed only in the one delivery
 * it is measured against, and where two deliveries overlap on the ground — PRJ-025's Queensland
 * main network and its P2 top-up — the other copy of every street it drove stayed red. New trips
 * get this from the engine as they are matched; this catches up the ones matched before.
 *
 * It runs each trip through attributeTripLinks, the worker's own path, so nothing here has rules of
 * its own: claims, takeovers, releases and the trip's figures come out exactly as a fresh
 * attribution would make them. Only trips measured against a delivery that shares the project with
 * another live delivery are visited — a lone delivery has nothing to gain.
 *
 * Usage
 *   node src/seed/backfillCrossDeliveryCoverage.js                       # dry run: which trips
 *   node src/seed/backfillCrossDeliveryCoverage.js --apply [--concurrency=4] [--since=<tripId>]
 *   Options: --project="PRJ-025-HE-DRIVE-AUSGNZ"
 */
const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const APPLY = args.get('apply') === true;
const CONCURRENCY = Math.max(1, Math.min(8, Number(args.get('concurrency')) || 4));
const log = (...a) => console.log(...a);

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../models/Trip');
  const Project = require('../models/Project');
  const LinkCoverage = require('../models/LinkCoverage');
  const { liveNetworkVersions } = require('../services/liveNetworks');
  const { attributeTripLinks } = require('../services/linkCoverage');

  const project = await Project.findOne({ name: PROJECT_NAME }).select('_id').lean();
  if (!project) throw new Error(`Project ${PROJECT_NAME} not found`);
  const live = (await liveNetworkVersions([project._id])).filter((v) => String(v.projectId) === String(project._id));
  log(`Live deliveries: ${live.length}`);
  if (live.length < 2) return log('Only one live delivery — nothing to catch up.');

  // A delivery whose extent meets no other's (Victoria beside two Queensland ones) has nothing to
  // gain: its trips are skipped rather than re-attributed for no change.
  const WorkArea = require('../models/WorkArea');
  const extents = await WorkArea.aggregate([
    { $match: { networkVersionId: { $in: live.map((v) => v._id) }, 'bbox.3': { $exists: true } } },
    {
      $group: {
        _id: '$networkVersionId',
        w: { $min: { $arrayElemAt: ['$bbox', 0] } }, s: { $min: { $arrayElemAt: ['$bbox', 1] } },
        e: { $max: { $arrayElemAt: ['$bbox', 2] } }, n: { $max: { $arrayElemAt: ['$bbox', 3] } },
      },
    },
  ]);
  const meets = (a, b) => a.w <= b.e && b.w <= a.e && a.s <= b.n && b.s <= a.n;
  const shared = extents.filter((a) => extents.some((b) => String(b._id) !== String(a._id) && meets(a, b))).map((a) => a._id);
  log(`Deliveries sharing ground with another: ${shared.length} of ${live.length}`);
  if (!shared.length) return log('No two deliveries meet — nothing to catch up.');

  const filter = {
    projectId: project._id,
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: 'matched',
    cleanedRouteShapes: { $exists: true, $ne: [] },
    assignedNetworkVersionId: { $in: shared },
  };
  if (args.has('since')) filter._id = { $gt: new mongoose.Types.ObjectId(String(args.get('since'))) };
  // Oldest first, as a rebuild would: ownership is decided by who got there first.
  const ids = (await Trip.find(filter).select('_id').sort({ _id: 1 }).lean()).map((t) => t._id);
  const before = await LinkCoverage.countDocuments({ projectId: project._id });
  log(`${ids.length} trips to re-attribute; ledger holds ${before.toLocaleString()} claims on the project`);
  if (!APPLY) return log('Dry run — add --apply.');

  let done = 0;
  let failed = 0;
  const queue = [...ids];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const id = queue.shift();
        for (let attempt = 1; ; attempt++) {
          try {
            await attributeTripLinks(id);
            break;
          } catch (err) {
            if (attempt >= 5) {
              failed += 1;
              log(`  FAILED ${id}: ${err.message}`);
              break;
            }
            log(`  retry ${attempt} ${id}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 5000 * attempt));
          }
        }
        done += 1;
        if (done % 25 === 0) log(`  ${done}/${ids.length} (last ${id})`);
      }
    })
  );
  const after = await LinkCoverage.countDocuments({ projectId: project._id });
  log(`\nDone: ${done} trips, ${failed} failed. Ledger ${before.toLocaleString()} → ${after.toLocaleString()} claims (+${(after - before).toLocaleString()}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
