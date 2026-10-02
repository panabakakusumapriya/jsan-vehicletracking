/**
 * Split a work area that is too big for one driver into zones — or join its zones back — from the
 * command line. The same operation as the panel's "Split into zones…" (see
 * services/workAreaSplit.js); this is for doing it without the panel, and for seeing the plan.
 *
 *   npm run split:area -- --version <id> --area <code>                    plan only; writes no areas
 *   npm run split:area -- --version <id> --area <code> --apply           split it
 *   npm run split:area -- --version <id> --area <code> --min 300 --max 300
 *   npm run split:area -- --version <id> --area <code> --keep-leftover   leftover as its own zone
 *   npm run split:area -- --version <id> --area <code> --join            put it back together
 *
 * --min / --max   how much road a zone should hold, km (default 250 / 300)
 * --keep-leftover when the road does not divide evenly, keep what is left over as a smaller zone
 *                 of its own instead of sharing it out among the zones (which then run a little
 *                 over --max)
 *
 * What a split writes: the zones (WorkArea), `areaId`/`areaCode` on the area's RoadLinks, `areaId`
 * on its LinkCoverage rows, the area and orphan counts on the NetworkVersion, and an AreaSplit
 * record holding the original area so --join can restore it. The area itself is deleted.
 *
 * What it never touches: trips, GPS, any other area, any other version. Refused while the area is
 * assigned to a driver or signed off. Safe to run again after a failure — it finishes the job.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const workAreaSplit = require('../services/workAreaSplit');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : null;
};
const log = (...a) => console.log(...a);

(async () => {
  const versionId = valueOf('--version');
  const areaCode = valueOf('--area');
  if (!versionId || !areaCode) {
    log('Usage: npm run split:area -- --version <networkVersionId> --area <areaCode> [--min 250] [--max 300] [--keep-leftover] [--apply | --join]');
    process.exit(1);
  }
  await connectDB();

  try {
    if (has('--join')) {
      const result = await workAreaSplit.joinSplitArea({ versionId, areaCode });
      if (result.alreadyJoined) log(`${result.area.name} is already back in one piece.`);
      else log(`Joined: ${result.removedZones} zones removed, ${result.area.name} restored — ${result.area.km.toFixed(1)} km, ${result.area.links} links.`);
    } else {
      const options = workAreaSplit.optionsFrom({
        minKm: valueOf('--min') || 250,
        maxKm: valueOf('--max') || 300,
        absorbRemainder: !has('--keep-leftover'),
      });
      const result = await workAreaSplit.splitCommittedArea({ versionId, areaCode, options, apply: has('--apply') });
      if (result.alreadySplit) {
        log(`Already split into ${result.zones.length} zones:`);
      } else {
        log(`${result.parent.name} [${result.parent.code}] — ${result.parent.km.toFixed(1)} km, ${result.parent.links} links`);
        log(`Zones of ${options.minKm}-${options.maxKm} km, leftover ${options.absorbRemainder ? 'shared out' : 'kept apart'}; place names: ${result.namesFrom}`);
        log(result.applied ? `SPLIT into ${result.zones.length} zones:` : `PLAN — ${result.zones.length} zones (nothing written; add --apply):`);
      }
      for (const zone of result.zones) {
        log(`  ${zone.code}  ${zone.km.toFixed(1).padStart(7)} km  ${String(zone.links).padStart(6)} links  ${zone.name}`);
      }
      if (result.unplacedLinks) log(`  ${result.unplacedLinks} link(s) fell in no zone and are now outside every area.`);
    }
  } catch (err) {
    log(`Refused: ${err.message}`);
    process.exitCode = 1;
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
