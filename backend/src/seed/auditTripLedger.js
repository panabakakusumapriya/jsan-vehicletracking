/**
 * Every trip's figures against the coverage ledger — the invariant that proves no road is lost or
 * counted twice: a computed trip's network UKM (linkUkmNetworkMeters) is exactly the km of the
 * ledger rows that name it first in the delivery it is measured in.
 *
 * Read-only; prints the trips that disagree. --ids=<file> writes their ids, one per line, for
 * recomputeCutTrips.js --ids=<file>.
 */
const fs = require('fs');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function main() {
  await connectDB();
  const db = require('mongoose').connection.db;
  const ledger = new Map();
  const cur = db.collection('linkcoverages').aggregate([
    { $group: { _id: { t: '$firstTripId', v: '$networkVersionId' }, m: { $sum: '$lengthMeters' } } },
  ], { allowDiskUse: true });
  for await (const r of cur) ledger.set(`${r._id.t}|${r._id.v}`, r.m);

  const trips = await db.collection('trips').find({ linkCoverageStatus: 'computed' })
    .project({ assignedNetworkVersionId: 1, linkUkmNetworkMeters: 1, driverId: 1, startedAt: 1 }).toArray();
  const bad = [];
  let ok = 0;
  for (const t of trips) {
    const want = ledger.get(`${t._id}|${t.assignedNetworkVersionId}`) || 0;
    const have = t.linkUkmNetworkMeters || 0;
    if (Math.abs(want - have) > 1) bad.push({ id: t._id, want, have });
    else ok++;
  }
  const up = bad.filter((b) => b.want > b.have);
  log(`Computed trips: ${trips.length} | agree with the ledger: ${ok} | disagree: ${bad.length}`);
  log(`  ledger names them for MORE than their figures say: ${up.length} trips, ${(up.reduce((s, b) => s + b.want - b.have, 0) / 1000).toFixed(1)} km`);
  log(`  ledger names them for LESS (their figures are stale-high): ${bad.length - up.length} trips, ${(bad.filter((b) => b.want < b.have).reduce((s, b) => s + b.have - b.want, 0) / 1000).toFixed(1)} km`);
  if (args.has('ids')) fs.writeFileSync(String(args.get('ids')), bad.map((b) => String(b.id)).join('\n'));
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
