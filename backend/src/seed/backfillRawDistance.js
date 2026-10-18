/**
 * Recompute every recorded trip's raw distance with the anomaly rules in utils/rawDistance.js.
 *
 * Ingest used to add the straight line between any two fixes more than 5 m apart, so GPS jumps,
 * two phones on one account and out-of-order backlogs all read as kilometres — up to four or five
 * times a driver's real day. This replays each trip's stored points through the same rule ingest
 * now applies, so history and new trips are measured alike.
 *
 * What it touches: Trip.distanceMeters only, on trips recorded by the app (importBatchId null)
 * that are not still active. The previous value is kept in Trip.rawDistanceBefore the first time a
 * trip changes, so --undo puts every figure back. Points, routes, matched distances and UKM are
 * never touched: UKM is measured on the matched route and was never inflated.
 *
 * A trip changes only when the new figure differs by more than 1 % AND 50 m, so GPS noise does not
 * rewrite thousands of trips by a few metres.
 *
 * Usage
 *   node src/seed/backfillRawDistance.js                # dry run: what would change, writes nothing
 *   node src/seed/backfillRawDistance.js --apply
 *   node src/seed/backfillRawDistance.js --undo --apply # restore rawDistanceBefore everywhere it is set
 *   Options: --since=YYYY-MM-DD  --driver=<userId>  --report=<file.json>
 */
const fs = require('fs');
const { connectDB } = require('../config/db');
const { sumMeters } = require('../utils/rawDistance');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const UNDO = args.get('undo') === true;
const log = (...a) => console.log(...a);

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const User = require('../models/User');

  if (UNDO) {
    const n = await Trip.countDocuments({ rawDistanceBefore: { $ne: null } });
    log(`${n} trips carry a rawDistanceBefore`);
    if (!APPLY) return log('Dry run — add --apply to restore them.');
    const cur = Trip.find({ rawDistanceBefore: { $ne: null } }).select('_id rawDistanceBefore').cursor();
    let done = 0;
    for await (const t of cur) {
      await Trip.updateOne({ _id: t._id }, { $set: { distanceMeters: t.rawDistanceBefore, rawDistanceBefore: null } });
      done++;
    }
    return log(`Restored ${done} trips.`);
  }

  const filter = { importBatchId: null, status: { $ne: 'active' }, pointCount: { $gt: 1 } };
  if (args.has('since')) filter.startedAt = { $gte: new Date(String(args.get('since'))) };
  if (args.has('driver')) filter.driverId = new mongoose.Types.ObjectId(String(args.get('driver')));

  const total = await Trip.countDocuments(filter);
  log(`${total} recorded trips to check${APPLY ? '' : ' (dry run)'}`);
  const cur = Trip.find(filter).select('_id driverId startedAt distanceMeters cleanedDistanceMeters rawDistanceBefore').sort({ startedAt: 1 }).lean().cursor();
  const changes = [];
  let seen = 0, beforeSum = 0, afterSum = 0;
  for await (const t of cur) {
    seen++;
    const pts = await LocationPoint.find({ tripId: t._id }).select('lat lon recordedAt accuracy').sort({ recordedAt: 1 }).lean();
    const after = Math.round(sumMeters(pts));
    const before = t.distanceMeters || 0;
    beforeSum += before; afterSum += after;
    if (Math.abs(after - before) > Math.max(50, before * 0.01)) {
      changes.push({ tripId: String(t._id), driverId: String(t.driverId), startedAt: t.startedAt, before, after, cleaned: t.cleanedDistanceMeters ?? null });
      if (APPLY) {
        await Trip.updateOne({ _id: t._id }, { $set: { distanceMeters: after, ...(t.rawDistanceBefore == null ? { rawDistanceBefore: before } : {}) } });
      }
    }
    if (seen % 500 === 0) log(`  ${seen}/${total} checked, ${changes.length} would change`);
  }
  const down = changes.filter((c) => c.after < c.before), up = changes.filter((c) => c.after > c.before);
  const km = (m) => Math.round(m / 1000).toLocaleString();
  log(`\nChecked ${seen} trips: ${km(beforeSum)} km before → ${km(afterSum)} km after (${km(beforeSum - afterSum)} km of jumps removed).`);
  log(`${changes.length} trips change: ${down.length} go down by ${km(down.reduce((s, c) => s + c.before - c.after, 0))} km, ${up.length} go up by ${km(up.reduce((s, c) => s + c.after - c.before, 0))} km.`);
  const names = new Map((await User.find({ _id: { $in: [...new Set(changes.map((c) => c.driverId))] } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const byDriver = {};
  for (const c of changes) { const n = names.get(c.driverId) || c.driverId; byDriver[n] = (byDriver[n] || 0) + (c.before - c.after); }
  log('\nkm removed by driver: ' + Object.entries(byDriver).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, v]) => `${n} ${km(v)}`).join(', '));
  log('\nBiggest reductions:');
  for (const c of down.sort((a, b) => (b.before - b.after) - (a.before - a.after)).slice(0, 12)) log(`  ${c.startedAt.toISOString().slice(0, 10)} ${(names.get(c.driverId) || '?').padEnd(26)} ${km(c.before)} → ${km(c.after)} km (matched ${c.cleaned != null ? km(c.cleaned) : '—'} km)`);
  if (args.has('report')) fs.writeFileSync(String(args.get('report')), JSON.stringify(changes));
  log(APPLY ? '\nApplied. Undo: node src/seed/backfillRawDistance.js --undo --apply' : '\nDry run — nothing written. Add --apply.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
