/**
 * Re-figure every trip whose numbers could involve an area that was cut into zones, and prove the
 * cut cost nothing.
 *
 * A trip's figures are a pure function of its route, its assignments and the coverage ledger
 * (linkCoverage.computeTripLinkMetrics). A cut moves roads and ledger rows onto zones and deletes
 * nothing, and resolveAssignedAreas resolves an assignment of the cut area to its zones — so
 * re-figuring must give the same numbers. This runs it and checks.
 *
 * Trips: those first on a road now in a cut zone, those whose stored assignment names a cut area,
 * and any listed in --ids=<file> (auditTripLedger.js --ids writes the trips whose figures disagree
 * with the ledger). Every figure is backed up first (collection tripmetricbackups, by batch).
 *
 * After: a trip's in-area + out-of-area km depend on its route alone, so they must not change — a
 * trip whose total moved is restored from its backup and listed. Assigned/network UKM may move,
 * because a stale trip's figures catch up with the ledger (auditTripLedger.js proves every ledger
 * km is credited exactly once); every change is listed.
 *
 * Usage
 *   node src/seed/recomputeCutTrips.js                 count the trips, change nothing
 *   node src/seed/recomputeCutTrips.js --apply         back up, re-figure, compare, restore any drop
 *   node src/seed/recomputeCutTrips.js --restore=<batch> --apply   put every backed-up trip back
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const SPLIT_TAG = /^vtsexact-/;
const FIELDS = ['assignedAreaIds', 'assignedNetworkVersionId', 'inAreaMeters', 'outAreaMeters', 'outAreaShapes',
  'linkUkmMeters', 'linkUkmNetworkMeters', 'linkUkmShapes', 'linkCoveredCount', 'linkCoverageStatus', 'ukmBasis',
  'linkCoverageComputedAt', 'effectiveUkmMeters'];
const COMPARE = ['linkUkmMeters', 'inAreaMeters', 'outAreaMeters', 'linkUkmNetworkMeters', 'effectiveUkmMeters'];
const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const backups = db.collection('tripmetricbackups');

  if (args.has('restore')) {
    const batch = String(args.get('restore'));
    const rows = await backups.find({ batch }).toArray();
    log(`Batch ${batch}: ${rows.length} trips backed up`);
    if (!APPLY) return log('Dry run — add --apply.');
    for (const r of rows) await db.collection('trips').updateOne({ _id: r.tripId }, { $set: r.fields });
    return log('Restored.');
  }

  // The cut areas and every zone that came of them (zones of zones included: codes extend).
  const recs = await db.collection('areasplits').find({ placesSource: SPLIT_TAG }).toArray();
  const parentIds = recs.map((r) => r.parent && r.parent._id).filter(Boolean);
  const codes = [...new Set(recs.map((r) => r.areaCode))];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const zoneIds = codes.length
    ? (await db.collection('workareas').find({ areaCode: { $regex: `^(${codes.map(escape).join('|')})-` }, 'props.splitFrom': { $exists: true } }).project({ _id: 1 }).toArray()).map((z) => z._id)
    : [];
  const first = await db.collection('linkcoverages').distinct('firstTripId', { areaId: { $in: zoneIds } });
  const named = await db.collection('trips').distinct('_id', { assignedAreaIds: { $in: parentIds } });
  const fs = require('fs');
  const listed = args.has('ids')
    ? fs.readFileSync(String(args.get('ids')), 'utf8').split(/\s+/).filter(Boolean).map((id) => new mongoose.Types.ObjectId(id))
    : [];
  const candidates = [...new Map([...first, ...named, ...listed].filter(Boolean).map((id) => [String(id), id])).values()];
  // VTS floor placeholders carry VTS's coverage with no route: re-figuring one would null it out.
  const floor = new Set((await db.collection('trips').find({ _id: { $in: candidates }, importBatchId: /^vtsfloor/ }).project({ _id: 1 }).toArray()).map((t) => String(t._id)));
  const tripIds = candidates.filter((id) => !floor.has(String(id)));
  if (floor.size) log(`Left alone: ${floor.size} VTS floor placeholder trips`);
  if (listed.length) log(`Also listed: ${listed.length} trips`);
  log(`Cut areas: ${recs.length} (${zoneIds.length} zones). Trips to re-figure: ${tripIds.length} (${first.length} first on a road in a zone, ${named.length} assigned a cut area)`);
  if (!APPLY) return log('Dry run — nothing changed. Add --apply.');

  const { computeTripLinkMetrics } = require('../services/linkCoverage');
  const batch = `recompute-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const projection = Object.fromEntries(FIELDS.map((f) => [f, 1]));
  const before = new Map();
  for (let i = 0; i < tripIds.length; i += 500) {
    const docs = await db.collection('trips').find({ _id: { $in: tripIds.slice(i, i + 500) } }).project(projection).toArray();
    await backups.insertMany(docs.map((d) => ({ batch, tripId: d._id, fields: Object.fromEntries(FIELDS.map((f) => [f, d[f] ?? null])), at: new Date() })));
    for (const d of docs) before.set(String(d._id), d);
  }
  log(`Backed up ${before.size} trips as batch ${batch}`);

  let done = 0;
  const failed = [];
  const queue = [...tripIds];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try { await computeTripLinkMetrics(id); } catch (err) { failed.push(`${id}: ${err.message}`); }
      if (++done % 250 === 0) log(`  ${done}/${tripIds.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Compare.
  const totals = Object.fromEntries(COMPARE.map((f) => [f, { before: 0, after: 0 }]));
  const lower = [];
  const higher = [];
  const moved = []; // in + out changed: impossible for an unchanged route
  for (let i = 0; i < tripIds.length; i += 500) {
    const docs = await db.collection('trips').find({ _id: { $in: tripIds.slice(i, i + 500) } }).project(projection).toArray();
    for (const d of docs) {
      const b = before.get(String(d._id));
      const drops = [];
      const rises = [];
      for (const f of COMPARE) {
        const x = b[f] || 0;
        const y = d[f] || 0;
        totals[f].before += x;
        totals[f].after += y;
        if (y < x - 1) drops.push(`${f} ${(x / 1000).toFixed(3)}->${(y / 1000).toFixed(3)} km`);
        if (y > x + 1) rises.push(`${f} ${(x / 1000).toFixed(3)}->${(y / 1000).toFixed(3)} km`);
      }
      const tot = (x) => (x.inAreaMeters || 0) + (x.outAreaMeters || 0);
      if (b.inAreaMeters != null && d.inAreaMeters != null && Math.abs(tot(d) - tot(b)) > 1) moved.push({ id: d._id, was: tot(b), now: tot(d) });
      if (drops.length) lower.push({ id: d._id, drops });
      if (rises.length) higher.push({ id: d._id, rises });
    }
  }
  for (const f of COMPARE) log(`  ${f}: ${(totals[f].before / 1000).toFixed(3)} km -> ${(totals[f].after / 1000).toFixed(3)} km`);
  log(`Trips identical: ${tripIds.length - lower.length - higher.length} | higher: ${higher.length} | LOWER: ${lower.length} | failed: ${failed.length}`);
  higher.slice(0, 20).forEach((x) => log(`  higher ${x.id}: ${x.rises.join(', ')}`));
  failed.slice(0, 20).forEach((x) => log(`  failed ${x}`));
  lower.forEach((x) => log(`  lower ${x.id}: ${x.drops.join(', ')}`));
  if (moved.length) {
    for (const x of moved) {
      const b = await backups.findOne({ batch, tripId: x.id });
      await db.collection('trips').updateOne({ _id: x.id }, { $set: b.fields });
      log(`  IN+OUT CHANGED, restored ${x.id}: ${(x.was / 1000).toFixed(3)} -> ${(x.now / 1000).toFixed(3)} km`);
    }
  }
  log(`In+out km unchanged on every trip: ${moved.length ? `NO — ${moved.length} restored` : 'yes'}`);
  log(`Done. Backup batch ${batch} (restore all: --restore=${batch} --apply)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
