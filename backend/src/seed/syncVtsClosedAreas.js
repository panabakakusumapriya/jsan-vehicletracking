/**
 * Areas closed on the old VTS app, closed in Atlas ops too.
 *
 * VTS marks a closed area on the geofence itself (`forceCompleted: true`, `forceCompletedAt`,
 * `forceCompletedBy`): 601 in projaustralia and 14 in Singapore by 2026-11-02. Atlas showed none of
 * them closed, so drivers kept seeing finished ground as red and the operations team cross-checked
 * ~600 areas by hand before every assignment.
 *
 * Each closed VTS area is matched to the live deliveries' work areas — Singapore by code (its areas
 * were imported from VTS, the code is the geofence id), Australia by name confirmed by place (the
 * VTS area's centre within the Atlas area's box: "Emerald" is in both states). A matched area that
 * was split into zones closes every zone. Then exactly what "Mark completed" does
 * (network.controller completeArea): an AreaCompletion row for the project's cycle, with the
 * coverage at that moment, dated when VTS closed it; and every live assignment of the area
 * released, so it leaves the driver's phone and its roads show as done on the map.
 *
 * An area already signed off in Atlas is left as it is. Read-only on VTS (VTS_MONGODB_URI). DRY RUN
 * unless --apply. Everything written carries importBatchId "vtsclosed-…";
 *   --undo=<batch> --apply   removes those completions and puts the released assignments back.
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECTS = { projaustralia: '6a3233e935b68ccdc47a9785', Singapore: '6a2a9d42fb182e3c95de52e0' };
const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function undo(db, batch) {
  const comps = await db.collection('areacompletions').countDocuments({ importBatchId: batch });
  const asg = await db.collection('areaassignments').countDocuments({ releaseBatchId: batch });
  log(`Batch ${batch}: ${comps} completions, ${asg} released assignments`);
  if (!APPLY) return log('Dry run — add --apply.');
  await db.collection('areacompletions').deleteMany({ importBatchId: batch });
  await db.collection('areaassignments').updateMany({ releaseBatchId: batch }, { $set: { releasedAt: null, releasedBy: null }, $unset: { releaseBatchId: '', releaseReason: '' } });
  log('Undone.');
}

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  if (args.has('undo')) return undo(db, String(args.get('undo')));
  const { MongoClient, ObjectId } = mongoose.mongo;
  const v = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await v.connect();
  const vts = v.db();

  const project = await db.collection('projects').findOne({ name: PROJECT_NAME });
  const cycleId = project.coverageCycleId || '';
  const versions = await db.collection('networkversions').find({ projectId: project._id, status: { $in: ['active', 'superseded'] } }).project({ label: 1, region: 1 }).toArray();
  const areas = await db.collection('workareas').find({ networkVersionId: { $in: versions.map((x) => x._id) } })
    .project({ name: 1, areaCode: 1, bbox: 1, targetMeters: 1, networkVersionId: 1, 'props.splitFrom': 1 }).toArray();
  const byName = new Map();
  for (const a of areas) {
    const k = a.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }
  const byCode = new Map(areas.map((a) => [a.areaCode, a]));
  const zonesOf = new Map();
  for (const a of areas) {
    const from = a.props && a.props.splitFrom;
    if (!from) continue;
    if (!zonesOf.has(from.code)) zonesOf.set(from.code, []);
    zonesOf.get(from.code).push(a);
  }
  const done = new Set((await db.collection('areacompletions').find({ projectId: project._id, coverageCycleId: cycleId, status: 'completed' }).project({ areaCode: 1 }).toArray()).map((c) => c.areaCode));
  const vUsers = new Map((await vts.collection('users').find({}).project({ name: 1 }).toArray()).map((u) => [String(u._id), u.name]));

  const plan = [];
  const notFound = [];
  for (const [label, vp] of Object.entries(VTS_PROJECTS)) {
    const closed = await vts.collection('geofences').find({ project: new ObjectId(vp), forceCompleted: true, name: { $not: /^Assigned areas|Scope Area/ } })
      .project({ name: 1, bounds: 1, forceCompletedAt: 1, forceCompletedBy: 1 }).toArray();
    for (const g of closed) {
      let hits;
      if (label === 'Singapore') {
        hits = byCode.has(String(g._id)) ? [byCode.get(String(g._id))] : [];
      } else {
        const b = g.bounds || {};
        const cx = (b.minLng + b.maxLng) / 2;
        const cy = (b.minLat + b.maxLat) / 2;
        const named = byName.get(g.name.trim().toLowerCase()) || [];
        hits = named.filter((a) => !a.bbox || (cx >= a.bbox[0] - 0.05 && cx <= a.bbox[2] + 0.05 && cy >= a.bbox[1] - 0.05 && cy <= a.bbox[3] + 0.05));
        // One area of that name and its box did not confirm it (an area with no roads, whose box is
        // the outline's): the name alone is unambiguous.
        if (!hits.length && named.length === 1) hits = named;
      }
      // An Atlas area cut into zones closes as its zones; the parent no longer exists.
      const targets = hits.flatMap((a) => zonesOf.get(a.areaCode) || [a]);
      if (!hits.length && label !== 'Singapore') {
        const zones = [...zonesOf.values()].flat().filter((z) => z.props.splitFrom.name && z.props.splitFrom.name.trim().toLowerCase() === g.name.trim().toLowerCase());
        targets.push(...zones);
      }
      if (!targets.length) { notFound.push(`${g.name} (${label})`); continue; }
      for (const a of targets) plan.push({ g, a, label, closedBy: vUsers.get(String(g.forceCompletedBy)) || null });
    }
  }
  const seen = new Set();
  const todo = plan.filter((p) => { if (seen.has(p.a.areaCode)) return false; seen.add(p.a.areaCode); return true; });
  const already = todo.filter((p) => done.has(p.a.areaCode));
  // Never over a newer decision made in Atlas: an area reopened here, or (re)assigned here, after
  // VTS closed it stays as Atlas has it.
  const reopened = new Map((await db.collection('areacompletions').find({ projectId: project._id, coverageCycleId: cycleId, status: { $ne: 'completed' } }).project({ areaCode: 1, reopenedAt: 1, updatedAt: 1 }).toArray()).map((c) => [c.areaCode, c.reopenedAt || c.updatedAt]));
  const lastAssigned = new Map();
  for (const r of await db.collection('areaassignments').find({ projectId: project._id, releasedAt: null }).project({ areaCode: 1, assignedAt: 1, createdAt: 1 }).toArray()) {
    const t = r.assignedAt || r.createdAt;
    if (!lastAssigned.has(r.areaCode) || t > lastAssigned.get(r.areaCode)) lastAssigned.set(r.areaCode, t);
  }
  const newer = [];
  const fresh = todo.filter((p) => {
    if (done.has(p.a.areaCode)) return false;
    const closedAt = p.g.forceCompletedAt || new Date(0);
    const reo = reopened.get(p.a.areaCode);
    const asg = lastAssigned.get(p.a.areaCode);
    if (reo && reo > closedAt) { newer.push(`${p.a.name} [${p.a.areaCode}]: reopened in Atlas ${reo.toISOString().slice(0, 10)}`); return false; }
    if (asg && asg > closedAt) { newer.push(`${p.a.name} [${p.a.areaCode}]: assigned in Atlas ${asg.toISOString().slice(0, 10)}, after VTS closed it ${closedAt.toISOString().slice(0, 10)}`); return false; }
    return true;
  });
  const held = await db.collection('areaassignments').countDocuments({ projectId: project._id, areaCode: { $in: fresh.map((p) => p.a.areaCode) }, releasedAt: null });
  log(`VTS closed areas matched: ${todo.length} Atlas areas (${todo.filter((p) => p.label === 'Singapore').length} Singapore) | already signed off: ${already.length} | to close now: ${fresh.length} | assignments to release: ${held}`);
  log(`Not in any live Atlas delivery (${notFound.length}): ${notFound.join('; ')}`);
  log(`Left as Atlas has it — newer decision here (${newer.length})${newer.length ? ':\n  ' + newer.join('\n  ') : ''}`);
  if (!APPLY) { await v.close(); return log('\nDry run — nothing written. Add --apply.'); }

  const batch = `vtsclosed-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date();
  let n = 0;
  for (const { g, a, closedBy } of fresh) {
    const [cov] = await db.collection('linkcoverages').aggregate([{ $match: { areaId: a._id } }, { $group: { _id: '$firstDriverId', m: { $sum: '$lengthMeters' } } }, { $sort: { m: -1 } }]).toArray().then((rows) => [rows]);
    const covered = (cov || []).reduce((s, r) => s + r.m, 0);
    const top = (cov || [])[0];
    const topUser = top && top._id ? await db.collection('users').findOne({ _id: top._id }, { projection: { name: 1 } }) : null;
    await db.collection('areacompletions').updateOne(
      { projectId: project._id, coverageCycleId: cycleId, areaCode: a.areaCode },
      {
        $set: {
          status: 'completed', areaId: a._id, networkVersionId: a.networkVersionId, areaName: a.name,
          completedAt: g.forceCompletedAt || now, completedBy: null,
          completedByName: `VTS${closedBy ? ` — ${closedBy}` : ''}`,
          completedByDriverId: topUser ? topUser._id : null, completedByDriverName: topUser ? topUser.name : null,
          coveredMeters: covered, targetMeters: a.targetMeters,
          pctAtCompletion: a.targetMeters > 0 ? (covered / a.targetMeters) * 100 : 0,
          note: `Closed in VTS on ${(g.forceCompletedAt || now).toISOString().slice(0, 10)}`,
          reopenedAt: null, reopenedBy: null, reopenReason: null,
          importBatchId: batch, updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    await db.collection('areaassignments').updateMany(
      { projectId: project._id, areaCode: a.areaCode, releasedAt: null },
      { $set: { releasedAt: now, releasedBy: null, releaseBatchId: batch, releaseReason: 'closed in VTS' } }
    );
    n++;
    if (n % 50 === 0) log(`  ${n}/${fresh.length}`);
  }
  log(`Closed ${n} areas as batch ${batch}. Undo: node src/seed/syncVtsClosedAreas.js --undo=${batch} --apply`);
  await v.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
