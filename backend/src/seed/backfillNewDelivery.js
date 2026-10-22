/**
 * Credit a newly activated delivery with the driving already recorded on its ground.
 *
 * Activating a delivery attributes only the trips matched after it: everything recorded before —
 * app trips and imported VTS sessions alike — stays credited to the delivery it replaced, so the
 * new one starts almost empty. (VIC-P2, activated 2026-10-21, showed 128 km driven of 66,127 km
 * while ~640 Victorian trips had already driven it.) This replays those trips through the engine's
 * normal incremental step, linkCoverage.attributeTripLinks: each is measured against the delivery
 * it now belongs to, claims its roads there and in any other live delivery its route reaches, and
 * its UKM and in/out-of-area figures are recomputed — exactly as if it had been matched today.
 *
 * Which trips: the project's matched trips whose start, end or last fix lies inside the delivery's
 * area extent (its work areas' bbox union). Oldest first, as a rebuild would — ownership goes to
 * whoever reached a road first, and attributeTripLinks enforces that whatever the order, so a
 * concurrency above 1 only changes how often a claim changes hands on the way.
 *
 * Unlike linkCoverage.rebuildNetworkCoverage it clears nothing and visits only this ground, not
 * the whole project: safe to re-run, and a run that dies can be continued with --since=<tripId>.
 *
 * Usage
 *   node src/seed/backfillNewDelivery.js --version=<networkVersionId>              # dry run
 *   node src/seed/backfillNewDelivery.js --version=<id> --apply [--concurrency=3] [--since=<tripId>]
 */
const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const VERSION = args.has('version') ? String(args.get('version')) : null;
const APPLY = args.get('apply') === true;
const CONCURRENCY = Math.max(1, Math.min(8, Number(args.get('concurrency')) || 3));
const log = (...a) => console.log(...a);

async function main() {
  if (!VERSION) throw new Error('--version=<networkVersionId> is required');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../models/Trip');
  const NetworkVersion = require('../models/NetworkVersion');
  const WorkArea = require('../models/WorkArea');
  const LinkCoverage = require('../models/LinkCoverage');
  const { attributeTripLinks } = require('../services/linkCoverage');

  const version = await NetworkVersion.findById(VERSION).select('_id label projectId status').lean();
  if (!version) throw new Error(`No delivery ${VERSION}`);
  const [ext] = await WorkArea.aggregate([
    { $match: { networkVersionId: version._id, 'bbox.3': { $exists: true } } },
    {
      $group: {
        _id: null,
        w: { $min: { $arrayElemAt: ['$bbox', 0] } }, s: { $min: { $arrayElemAt: ['$bbox', 1] } },
        e: { $max: { $arrayElemAt: ['$bbox', 2] } }, n: { $max: { $arrayElemAt: ['$bbox', 3] } },
      },
    },
  ]);
  if (!ext) throw new Error('The delivery has no work areas with a bbox');
  log(`Delivery ${version.label} (${version.status}), extent ${[ext.w, ext.s, ext.e, ext.n].map((x) => x.toFixed(3)).join(', ')}`);

  const inside = (p) => ({ [`${p}.lon`]: { $gte: ext.w, $lte: ext.e }, [`${p}.lat`]: { $gte: ext.s, $lte: ext.n } });
  const filter = {
    projectId: version.projectId,
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: 'matched',
    cleanedRouteShapes: { $exists: true, $ne: [] },
    parkedJitter: { $ne: true },
    $or: [inside('startLocation'), inside('endLocation'), inside('lastLocation')],
  };
  if (args.has('since')) filter._id = { $gt: new mongoose.Types.ObjectId(String(args.get('since'))) };
  const trips = await Trip.find(filter).select('_id startedAt').sort({ startedAt: 1, _id: 1 }).lean();
  const measure = async () => {
    const [r] = await LinkCoverage.aggregate([
      { $match: { networkVersionId: version._id } },
      { $group: { _id: null, m: { $sum: '$lengthMeters' }, n: { $sum: 1 } } },
    ]);
    return { km: Math.round((r?.m || 0) / 1000), links: r?.n || 0 };
  };
  const before = await measure();
  log(`${trips.length} trips on this ground, ${trips[0]?.startedAt?.toISOString().slice(0, 10)} → ${trips.at(-1)?.startedAt?.toISOString().slice(0, 10)}`);
  log(`Delivery credited so far: ${before.km.toLocaleString()} km, ${before.links.toLocaleString()} links`);
  if (!APPLY) return log('Dry run — add --apply.');

  let done = 0;
  let failed = 0;
  const queue = trips.map((t) => t._id);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const id = queue.shift();
        for (let attempt = 1; ; attempt++) {
          try {
            await attributeTripLinks(id);
            break;
          } catch (err) {
            // The production database sits behind a TCP proxy that drops long connections.
            if (attempt >= 5) { failed += 1; log(`  FAILED ${id}: ${err.message}`); break; }
            log(`  retry ${attempt} ${id}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 5000 * attempt));
          }
        }
        done += 1;
        if (done % 25 === 0) {
          const now = await measure();
          log(`  ${done}/${trips.length} (last ${id}) — credited ${now.km.toLocaleString()} km, ${now.links.toLocaleString()} links`);
        }
      }
    })
  );
  const after = await measure();
  log(`\nDone: ${done} trips, ${failed} failed. Credited ${before.km.toLocaleString()} → ${after.km.toLocaleString()} km (${before.links.toLocaleString()} → ${after.links.toLocaleString()} links).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
