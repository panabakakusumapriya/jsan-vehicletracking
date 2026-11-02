/**
 * Give VTS-imported trips their real end time.
 *
 * importVtsSessions.js took a trip's end from the VTS session: `endTime`, else `lastHeartbeat`. Many
 * VTS sessions never got an endTime and were closed in bulk later (17 Sep 2026, 00:50 UTC), so a
 * 52 km drive on 25 Aug "ended" 22 days later — and a trip with GPS sometimes ended at a late
 * session end rather than its last fix. The kilometres are right; the times made the trips overlap
 * everything after them (2,562 overlapping pairs in the 2026-11-02 audit), which breaks working
 * hours and any same-time comparison of the driver's trips.
 *
 * New end time:
 *   - a trip with GPS points: its last fix;
 *   - a route-only trip (VTS kept no raw GPS): the session's endTime when it is under 24 h after the
 *     start, else start + VTS's own moving + idle minutes (stats), else start + km at 40 km/h;
 *   - never later than the start of the driver's next trip.
 * Only vts-… batches, only when the end moves by more than 30 min. --phone also takes phone trips
 * that ended more than 6 h after their last fix: trips left open on a phone and closed when it next
 * synced (Robert Falelua: 16 trips of Aug–Oct all "ended" on 1 Nov 05:44–05:48) — their end is
 * their last fix. The old value is kept in
 * `importOriginalEndedAt`; --undo puts it back. DRY RUN unless --apply. Reads VTS (VTS_MONGODB_URI)
 * for the session stats, read-only.
 */
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function main() {
  await connectDB();
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  if (args.get('undo') === true) {
    const r = APPLY
      ? await Trip.collection.updateMany({ importOriginalEndedAt: { $exists: true } }, [{ $set: { endedAt: '$importOriginalEndedAt' } }, { $unset: 'importOriginalEndedAt' }])
      : { modifiedCount: await Trip.countDocuments({ importOriginalEndedAt: { $exists: true } }) };
    return log(`${APPLY ? 'Restored' : 'Would restore'} ${r.modifiedCount} trips`);
  }
  const { MongoClient, ObjectId } = require('mongoose').mongo;
  const v = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await v.connect();
  const vts = v.db();

  const PHONE = args.get('phone') === true;
  const trips = await Trip.find({
    importOriginalEndedAt: { $exists: false },
    endedAt: { $ne: null },
    $or: [
      { importBatchId: /^vts-/ },
      ...(PHONE ? [{ importBatchId: null, pointCount: { $gt: 0 }, $expr: { $gt: [{ $subtract: ['$endedAt', '$startedAt'] }, 16 * 3600e3] } }] : []),
    ],
  })
    .select('driverId startedAt endedAt pointCount distanceMeters importSourceId importBatchId').lean();
  const byDriver = new Map();
  for (const t of await Trip.find({ driverId: { $in: [...new Set(trips.map((t) => String(t.driverId)))] } }).select('driverId startedAt').lean()) {
    const k = String(t.driverId);
    if (!byDriver.has(k)) byDriver.set(k, []);
    byDriver.get(k).push(t.startedAt.getTime());
  }
  for (const list of byDriver.values()) list.sort((a, b) => a - b);
  const nextStart = (t) => (byDriver.get(String(t.driverId)) || []).find((ms) => ms > t.startedAt.getTime()) ?? Infinity;

  const changes = [];
  const why = {};
  for (const t of trips) {
    const start = t.startedAt.getTime();
    let end;
    let rule;
    if (t.pointCount > 0) {
      const last = await LocationPoint.findOne({ tripId: t._id }).sort({ recordedAt: -1 }).select('recordedAt').lean();
      if (!last) continue;
      end = last.recordedAt.getTime();
      rule = t.importBatchId ? 'last GPS fix' : 'phone trip: last GPS fix';
      if (!t.importBatchId && t.endedAt.getTime() - end <= 6 * 3600e3) continue;
    } else {
      const id = String(t.importSourceId || '').replace(/^vts:/, '').split('@')[0];
      const s = /^[0-9a-f]{24}$/i.test(id) ? await vts.collection('sessions').findOne({ _id: new ObjectId(id) }, { projection: { endTime: 1, stats: 1 } }) : null;
      const e = s && s.endTime ? new Date(s.endTime).getTime() : null;
      const minutes = s && s.stats ? (s.stats.movingTime || 0) + (s.stats.idleTime || 0) : 0;
      if (e && e > start && e - start < 24 * 3600e3) { end = e; rule = 'VTS session end'; }
      else if (minutes > 0) { end = start + minutes * 60000; rule = 'VTS driving time'; }
      else { end = start + ((t.distanceMeters || 0) / 1000 / 40) * 3600e3; rule = 'km at 40 km/h'; }
    }
    end = Math.max(start, Math.min(end, nextStart(t)));
    if (Math.abs(end - t.endedAt.getTime()) <= 30 * 60000) continue;
    changes.push({ _id: t._id, old: t.endedAt, end: new Date(end), rule });
    why[rule] = (why[rule] || 0) + 1;
  }
  log(`VTS-imported trips: ${trips.length}; end time to correct: ${changes.length} ${JSON.stringify(why)}`);
  for (const c of changes.slice(0, 6)) log(`  ${c._id}: ${c.old.toISOString().slice(0, 16)} -> ${c.end.toISOString().slice(0, 16)} (${c.rule})`);
  if (APPLY && changes.length) {
    await Trip.collection.bulkWrite(changes.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { endedAt: c.end, importOriginalEndedAt: c.old } } } })));
    log(`Corrected ${changes.length} trips. Undo: node src/seed/fixVtsTripTimes.js --undo --apply`);
  } else if (!APPLY) log('Dry run — nothing written. Add --apply.');
  await v.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
