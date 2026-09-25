/**
 * Give imported trips a route to draw, built from the roads they are recorded as having covered.
 *
 * What this does and does not claim
 * ---------------------------------
 * An imported trip comes from a customer's cleaned GIS file: roads, a driver and a date, with no
 * GPS whatsoever. It therefore has a distance and a coverage ledger but nothing to draw, which
 * makes a real day's work look like a failed recording.
 *
 * This fills `cleanedRouteShapes` from the geometry of the links that trip first covered. That
 * field is defined as "server-decided map geometry; the client draws these, it never derives
 * them", which is exactly what these are — the customer's own road centrelines. So the POSITIONS
 * are accurate: they are the roads, as delivered.
 *
 * What is NOT reconstructed, because the source does not contain it:
 *   - the time each position was reached. The file carries a date, not a clock.
 *   - speed. Never measured.
 *   - the ORDER the roads were driven in. Chunks are therefore kept separate, one per link, and
 *     never joined end to end — a single merged polyline would draw confident straight lines
 *     between roads in an order nobody recorded.
 *
 * `pointCount` is left at 0 on purpose: it counts GPS fixes a handset recorded, and there were
 * none. The number of derived positions goes in `cleanedPointCount`, so neither figure lies.
 *
 * Usage:
 *   node src/seed/deriveImportedRoutes.js                 # dry run
 *   node src/seed/deriveImportedRoutes.js --apply
 *   node src/seed/deriveImportedRoutes.js --batch=<id> --apply
 *   node src/seed/deriveImportedRoutes.js --revert --apply
 */
const { connectDB } = require('../config/db');
const { encodePolyline6 } = require('../services/valhalla');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const REVERT = args.get('revert') === true;
const BATCH = args.get('batch') ? String(args.get('batch')) : null;

async function main() {
  const mongoose = require('mongoose');
  await connectDB();
  const Trip = require('../models/Trip');
  const LinkCoverage = require('../models/LinkCoverage');
  const RoadLink = require('../models/RoadLink');

  const tripFilter = { importBatchId: BATCH ? BATCH : { $ne: null } };

  if (REVERT) {
    const n = await Trip.countDocuments({ ...tripFilter, cleanedRouteShapes: { $exists: true, $ne: [] } });
    console.log(`trips with a derived route: ${n}`);
    if (!APPLY) {
      console.log('DRY RUN — re-run with --apply to strip them.');
    } else {
      const res = await Trip.updateMany(tripFilter, {
        $unset: { cleanedRouteShapes: '', cleanedPointCount: '' },
      });
      console.log(`stripped routes from ${res.modifiedCount} trips`);
    }
    await mongoose.disconnect();
    return;
  }

  const trips = await Trip.find(tripFilter).select('_id importBatchId startedAt driverId').lean();
  console.log(`imported trips: ${trips.length}`);
  console.log(`mode : ${APPLY ? 'APPLY — will write' : 'DRY RUN — reads only'}\n`);

  let done = 0;
  let withRoute = 0;
  let totalVertices = 0;
  let totalChunks = 0;
  let noLinks = 0;

  for (const trip of trips) {
    // The links this trip FIRST covered — its own contribution, not every road inside the area.
    const claims = await LinkCoverage.find({ firstTripId: trip._id })
      .select('linkId networkVersionId -_id')
      .lean();
    if (!claims.length) {
      noLinks++;
      done++;
      continue;
    }
    /**
     * Grouped by network version, because roadlinks is indexed on {networkVersionId, linkId} and
     * has no index on linkId alone. Querying by link id by itself cannot use that compound index
     * and scans all 1.29M road documents per batch — the difference between minutes and hours.
     */
    const idsByVersion = new Map();
    for (const c of claims) {
      const key = String(c.networkVersionId);
      if (!idsByVersion.has(key)) idsByVersion.set(key, []);
      idsByVersion.get(key).push(c.linkId);
    }

    const shapes = [];
    let vertices = 0;
    // Batched: a single day can claim several thousand links, and one $in of that size is a
    // needlessly large query plan.
    for (const [versionId, ids] of idsByVersion) {
      for (let i = 0; i < ids.length; i += 1000) {
        const links = await RoadLink.find({
          networkVersionId: versionId,
          linkId: { $in: ids.slice(i, i + 1000) },
        })
          .select('geometry.coordinates -_id')
          .lean();
        for (const l of links) {
          const coords = l.geometry?.coordinates;
          if (!Array.isArray(coords) || coords.length < 2) continue;
          // One chunk per road. Never concatenated — see the note above about order.
          shapes.push(encodePolyline6(coords.map(([lon, lat]) => ({ lat, lon }))));
          vertices += coords.length;
        }
      }
    }

    if (!shapes.length) {
      noLinks++;
      done++;
      continue;
    }

    withRoute++;
    totalChunks += shapes.length;
    totalVertices += vertices;

    if (APPLY) {
      await Trip.updateOne(
        { _id: trip._id },
        { $set: { cleanedRouteShapes: shapes, cleanedPointCount: vertices } }
      );
    }

    done++;
    if (done % 25 === 0) process.stdout.write(`\r  processed ${done}/${trips.length}`);
  }

  console.log(`\r  processed ${done}/${trips.length}                `);
  console.log(`\ntrips that gain a route : ${withRoute}`);
  console.log(`trips with no claimed link: ${noLinks} (nothing to draw — left as they are)`);
  console.log(`road chunks written       : ${totalChunks.toLocaleString()}`);
  console.log(`derived positions         : ${totalVertices.toLocaleString()}`);
  console.log(
    `average per trip          : ${withRoute ? Math.round(totalVertices / withRoute).toLocaleString() : 0} positions across ${withRoute ? Math.round(totalChunks / withRoute) : 0} roads`
  );

  if (!APPLY) console.log('\nDRY RUN — nothing was written. Re-run with --apply.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
