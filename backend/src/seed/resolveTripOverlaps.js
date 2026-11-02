/**
 * One drive recorded twice — by the phone and by VTS at the same time — kept once.
 *
 * Drivers ran both apps. The VTS sync skips a session when the driver already has Atlas data that
 * day, but some got in anyway: a driver whose phone trips sat on a second login (Samson, 26–30 Oct),
 * or a session imported before the phone's trips of that day were uploaded. Those kilometres then
 * count twice in distance and working hours (coverage counts each road once regardless).
 *
 * For each driver it groups trips whose times overlap by more than 2 minutes and that come from
 * both sources (phone, and a vts-… import). In each group the phone's trips are kept unless VTS has
 * clearly more kilometres (over 5 % and 1 km) — and the other side's trips are archived exactly as replaceDaysWithVts.js
 * archives a day (archivedtrips / archivedlocationpoints, claims released), so its tools apply:
 *   node src/seed/replaceDaysWithVts.js --settle=<batch> --apply   re-claim and refresh UKM around them
 *   node src/seed/replaceDaysWithVts.js --undo=<batch> --apply     put the archived trips back
 * Overlaps between two 2025 GIS-import days are reported only (fixed working-window times).
 *
 * DRY RUN unless --apply. Options: --driver=<email> (one driver), --exclude=<email,…>
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const ONLY = args.has('driver') ? String(args.get('driver')).toLowerCase() : null;
const EXCLUDE = new Set(String(args.get('exclude') || '').toLowerCase().split(',').filter(Boolean));
const OVERLAP_MS = 2 * 60000;
const log = (...a) => console.log(...a); // eslint-disable-line no-console
const source = (t) => (!t.importBatchId ? 'phone' : /^vts-/.test(t.importBatchId) ? 'vts' : 'other');

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const LinkCoverage = require('../models/LinkCoverage');
  const CoverageSegment = require('../models/CoverageSegment');
  const { formatDateInZone } = require('../utils/timezone');

  const drivers = await db.collection('users').find({ role: 'user' }).project({ name: 1, email: 1 }).toArray();
  const batch = `vtsday-ovl-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const plan = [];
  let reported = 0;
  for (const d of drivers) {
    const email = String(d.email || '').toLowerCase();
    if ((ONLY && email !== ONLY) || EXCLUDE.has(email)) continue;
    const ts = await Trip.find({ driverId: d._id, parkedJitter: { $ne: true }, distanceMeters: { $gt: 0 }, status: { $ne: 'active' } })
      .select('startedAt endedAt distanceMeters importBatchId timezone').sort({ startedAt: 1 }).lean();
    // Groups of trips joined by overlaps.
    const parent = ts.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < ts.length; i++) {
      const ae = (ts[i].endedAt || ts[i].startedAt).getTime();
      for (let j = i + 1; j < ts.length && ts[j].startedAt.getTime() < ae; j++) {
        const be = (ts[j].endedAt || ts[j].startedAt).getTime();
        if (Math.min(ae, be) - Math.max(ts[i].startedAt.getTime(), ts[j].startedAt.getTime()) > OVERLAP_MS) parent[find(j)] = find(i);
      }
    }
    const groups = new Map();
    ts.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const phone = g.filter((t) => source(t) === 'phone');
      const vts = g.filter((t) => source(t) === 'vts');
      if (!phone.length || !vts.length) { if (g.length > 1) reported++; continue; }
      const pKm = phone.reduce((s, t) => s + t.distanceMeters, 0) / 1000;
      const vKm = vts.reduce((s, t) => s + t.distanceMeters, 0) / 1000;
      // The phone's own recording is kept unless VTS is clearly fuller: markers hang off phone trips,
      // and two recordings of one drive differ by a few hundred metres (Samson: 578.4 vs 579.3 km).
      const vtsWins = vKm > pKm * 1.05 && vKm - pKm > 1;
      const lose = vtsWins ? phone : vts;
      plan.push({ d, day: formatDateInZone(g[0].startedAt, g[0].timezone || 'Australia/Melbourne'), pKm, vKm, keep: vtsWins ? 'VTS' : 'phone', lose });
    }
  }
  log(`Trips recorded twice (phone + VTS at the same time): ${plan.length} groups`);
  for (const p of plan) log(`  ${p.day} ${p.d.name.padEnd(30)} phone ${p.pKm.toFixed(1).padStart(7)} km | VTS ${p.vKm.toFixed(1).padStart(7)} km → keep ${p.keep}, archive ${p.lose.length} trip(s)`);
  log(`Other overlaps reported only (two imports of the same source): ${reported}`);
  if (!APPLY || !plan.length) return log(APPLY ? 'Nothing to do.' : '\nDry run — nothing written. Add --apply.');

  for (const p of plan) {
    const ids = p.lose.map((t) => t._id);
    const full = await Trip.find({ _id: { $in: ids } }).lean();
    const pts = await LocationPoint.find({ tripId: { $in: ids } }).lean();
    const meta = { batch, archivedAt: new Date(), reason: `same drive recorded twice — kept ${p.keep}`, day: p.day, driverId: p.d._id, atlasKm: p.pKm, vtsKm: p.vKm };
    if (full.length) await db.collection('archivedtrips').insertMany(full.map((t) => ({ ...t, archive: meta })), { ordered: false }).catch((e) => { if (e.code !== 11000 && !e.writeErrors) throw e; });
    for (let i = 0; i < pts.length; i += 5000) {
      await db.collection('archivedlocationpoints').insertMany(pts.slice(i, i + 5000).map((x) => ({ ...x, archiveBatch: batch })), { ordered: false }).catch((e) => { if (e.code !== 11000 && !e.writeErrors) throw e; });
    }
    await LocationPoint.deleteMany({ tripId: { $in: ids } });
    await Trip.deleteMany({ _id: { $in: ids } });
    await CoverageSegment.deleteMany({ firstTripId: { $in: ids } });
    await LinkCoverage.deleteMany({ firstTripId: { $in: ids } });
  }
  log(`Archived as batch ${batch}.`);
  log(`Now: node src/seed/replaceDaysWithVts.js --settle=${batch} --apply`);
  log(`Undo: node src/seed/replaceDaysWithVts.js --undo=${batch} --apply`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
