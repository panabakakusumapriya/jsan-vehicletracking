/**
 * Areas closed on VTS, closed in Atlas EXACTLY — by the ground, not by the name.
 *
 * syncVtsClosedAreas.js matched VTS areas to Atlas areas by name (confirmed by place). Checked
 * against the real shapes on 2026-11-03 that was right for 607 of 615, and wrong in two ways for
 * the rest: a VTS-closed suburb that lies inside a much bigger Atlas polygon (the QLD-highways
 * delivery's drawn zones each hold dozens of suburbs), and an Atlas polygon that carries a closed
 * suburb's NAME but is really a different, still-open VTS piece (VTS keeps some areas as 30+
 * same-named pieces).
 *
 * Here the unit of truth is a ROAD: a road link is closed when its midpoint lies on ground VTS
 * closed (inside a forceCompleted geofence of projaustralia). Then, per Atlas area of the live
 * Australian deliveries, from the km of its roads on closed ground:
 *   - share >= COMPLETE_SHARE           -> the area is completed (as "Mark completed" does);
 *   - a VTS-closed area mostly inside it (>= CUT_V_SHARE of that VTS area's roads here) but the
 *     Atlas area is much bigger          -> CUT: the closed part becomes its own zone, completed,
 *                                           the rest stays a zone, open (props.splitFrom, the
 *                                           panel's "join zones back" restores the area);
 *   - only border slivers               -> nothing; boundaries of two systems never agree exactly.
 * An area completed by the name-based batch whose share is below RELEASE_SHARE is reopened — the
 * name match got it wrong. Nothing a person did in Atlas is touched: an area completed or
 * reopened by a manager stays as it is, and an area held by a driver is not cut (listed instead).
 *
 * Read-only on VTS (VTS_MONGODB_URI). DRY RUN unless --apply. Batch "vtsexact-…";
 *   --undo=<batch> --apply   joins the cut areas back, removes the completions it wrote and
 *                            restores the ones it reopened.
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECT = '6a3233e935b68ccdc47a9785'; // projaustralia
const NAME_BATCH = /^vtsclosed-/; // completions written by syncVtsClosedAreas.js
const VTS_BATCH = /^vts(closed|exact)-/; // …or by this script
const COMPLETE_SHARE = 0.9;
const CUT_V_SHARE = 0.5;
const CUT_MIN_KM = 0.5;
const RELEASE_SHARE = 0.1;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

// Even-odd point-in-polygon over every ring: robust to the self-crossing edges some VTS and
// customer polygons have (polygon-clipping refuses those).
function inRings(x, y, rings) {
  let c = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
function midpoint(coords) {
  // Halfway along the line, as the import assigns links to areas.
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  let half = total / 2;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
    if (half <= d && d > 0) { const t = half / d; return [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])]; }
    half -= d;
  }
  return coords[0];
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
  const versions = await db.collection('networkversions').find({ projectId: project._id, status: { $in: ['active', 'superseded'] }, region: 'Australia' }).project({ label: 1 }).toArray();
  const versionIds = versions.map((x) => x._id);
  const label = new Map(versions.map((x) => [String(x._id), x.label]));

  // 1. VTS-closed ground.
  const closed = await vts.collection('geofences').find({ project: new ObjectId(VTS_PROJECT), forceCompleted: true, name: { $not: /^Assigned areas|Scope Area/ } })
    .project({ name: 1, polygon: 1, polygons: 1, forceCompletedAt: 1 }).toArray();
  const vPolys = closed.map((g) => {
    const rings = (Array.isArray(g.polygons) && g.polygons.length ? g.polygons : [g.polygon]).filter((r) => Array.isArray(r) && r.length > 2).map((r) => r.map((p) => [p.lng, p.lat]));
    let b = [180, 90, -180, -90];
    for (const r of rings) for (const [x, y] of r) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return { id: String(g._id), name: g.name, at: g.forceCompletedAt, rings, bbox: b };
  }).filter((p) => p.rings.length);
  await v.close();
  log(`VTS: ${vPolys.length} closed areas (projaustralia) | Atlas: ${versions.length} live Australian deliveries`);

  // 2. Roads on that ground, per Atlas area: per (VTS area, Atlas area) km, and the link ids.
  const linkSeen = new Set();
  const areaClosedM = new Map(); // areaId -> metres on closed ground (each link once)
  const areaClosedLinks = new Map(); // areaId -> Set(link _id)
  const pair = new Map(); // `${vId}|${areaId}` -> metres
  const vTotal = new Map(); // `${vId}|${versionId}` -> metres of roads in V, per delivery
  let n = 0;
  for (const p of vPolys) {
    const box = { type: 'Polygon', coordinates: [[[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[1]], [p.bbox[2], p.bbox[3]], [p.bbox[0], p.bbox[3]], [p.bbox[0], p.bbox[1]]]] };
    // eslint-disable-next-line no-await-in-loop
    const links = await db.collection('roadlinks').find({ networkVersionId: { $in: versionIds }, geometry: { $geoIntersects: { $geometry: box } } })
      .project({ areaId: 1, networkVersionId: 1, lengthMeters: 1, 'geometry.coordinates': 1 }).toArray();
    for (const l of links) {
      const [x, y] = midpoint(l.geometry.coordinates);
      if (x < p.bbox[0] || x > p.bbox[2] || y < p.bbox[1] || y > p.bbox[3] || !inRings(x, y, p.rings)) continue;
      const vk = `${p.id}|${l.networkVersionId}`;
      vTotal.set(vk, (vTotal.get(vk) || 0) + l.lengthMeters);
      if (!l.areaId) continue;
      const a = String(l.areaId);
      pair.set(`${p.id}|${a}`, (pair.get(`${p.id}|${a}`) || 0) + l.lengthMeters);
      const lk = String(l._id);
      if (linkSeen.has(lk)) continue;
      linkSeen.add(lk);
      areaClosedM.set(a, (areaClosedM.get(a) || 0) + l.lengthMeters);
      if (!areaClosedLinks.has(a)) areaClosedLinks.set(a, new Set());
      areaClosedLinks.get(a).add(lk);
    }
    if (++n % 100 === 0) log(`  ${n}/${vPolys.length} VTS areas scanned`);
  }

  // 3. Decide per Atlas area — no tolerance. Counted in road links, not km: "all" means every road.
  const areas = await db.collection('workareas').find({ networkVersionId: { $in: versionIds } })
    .project({ name: 1, areaCode: 1, targetMeters: 1, networkVersionId: 1, 'props.splitFrom': 1 }).toArray();
  const linkCount = new Map((await db.collection('roadlinks').aggregate([
    { $match: { networkVersionId: { $in: versionIds }, areaId: { $ne: null } } },
    { $group: { _id: '$areaId', n: { $sum: 1 } } },
  ]).toArray()).map((r) => [String(r._id), r.n]));
  const comps = new Map((await db.collection('areacompletions').find({ projectId: project._id, coverageCycleId: cycleId }).toArray()).map((c) => [c.areaCode, c]));
  const heldCodes = new Set(await db.collection('areaassignments').distinct('areaCode', { projectId: project._id, releasedAt: null }));
  const vById = new Map(vPolys.map((p) => [p.id, p]));

  const plan = { complete: [], cut: [], reopen: [], alreadyRight: 0, blockedHeld: [], blockedManager: [] };
  for (const a of areas) {
    const id = String(a._id);
    const total = a.targetMeters || 0;
    const onClosed = areaClosedM.get(id) || 0;
    const roads = linkCount.get(id) || 0;
    const closedRoads = (areaClosedLinks.get(id) || new Set()).size;
    const comp = comps.get(a.areaCode);
    const isDone = comp && comp.status === 'completed';
    // Completed by one of these VTS scripts (ours to correct), not by a person.
    const byVts = isDone && VTS_BATCH.test(comp.importBatchId || '');
    const reopenedByManager = comp && comp.status !== 'completed' && (comp.reopenedBy || !VTS_BATCH.test(comp.importBatchId || ''));
    const tag = `${a.name} [${a.areaCode}] ${label.get(String(a.networkVersionId))} — ${closedRoads} of ${roads} roads (${(onClosed / 1000).toFixed(2)} of ${(total / 1000).toFixed(2)} km) on VTS-closed ground`;
    if (!roads) { plan.alreadyRight++; continue; } // nothing to drive: a 0 km area follows no road

    if (closedRoads === roads) { // every road closed on VTS
      if (isDone) { plan.alreadyRight++; continue; }
      if (reopenedByManager) { plan.blockedManager.push(`${tag} — reopened by a manager, left open`); continue; }
      if (heldCodes.has(a.areaCode)) { plan.blockedHeld.push(`${tag} — held by a driver in Atlas, not closed`); continue; }
      plan.complete.push({ a, tag });
      continue;
    }
    if (closedRoads === 0) { // no road closed on VTS
      if (byVts) plan.reopen.push({ a, tag, comp });
      else plan.alreadyRight++;
      continue;
    }
    // Some roads closed, some not: cut, whatever the share.
    if (heldCodes.has(a.areaCode)) { plan.blockedHeld.push(`${tag} — held by a driver in Atlas, not cut`); continue; }
    if (isDone && !byVts) { plan.blockedManager.push(`${tag} — signed off by a manager in Atlas, not cut`); continue; }
    if (reopenedByManager) { plan.blockedManager.push(`${tag} — reopened by a manager, not cut`); continue; }
    const inside = [];
    for (const [k, m] of pair) {
      const [vid, aid] = k.split('|');
      if (aid === id) inside.push({ v: vById.get(vid), m });
    }
    plan.cut.push({ a, tag, inside, comp: isDone ? comp : null });
  }

  const km = (xs) => (xs.reduce((t, x) => t + (x.a.targetMeters || 0), 0) / 1000).toFixed(1);
  log(`\nAlready right: ${plan.alreadyRight}`);
  log(`\nComplete — every road on VTS-closed ground (${plan.complete.length}, ${km(plan.complete)} km):`);
  plan.complete.forEach((x) => log(`  ${x.tag}`));
  log(`\nCut — some roads closed on VTS, some not (${plan.cut.length}, ${km(plan.cut)} km; ${plan.cut.filter((x) => x.comp).length} of them completed now, by a VTS sync):`);
  plan.cut.forEach((x) => log(`  ${x.tag}${x.comp ? ' [completed now]' : ''}`));
  log(`\nReopen — completed by a VTS sync, but no road of it is closed on VTS (${plan.reopen.length}):`);
  plan.reopen.forEach((x) => log(`  ${x.tag}`));
  if (plan.blockedHeld.length) { log(`\nLeft — a driver holds it (${plan.blockedHeld.length}):`); plan.blockedHeld.forEach((x) => log(`  ${x}`)); }
  if (plan.blockedManager.length) { log(`\nLeft — as a manager set it (${plan.blockedManager.length}):`); plan.blockedManager.forEach((x) => log(`  ${x}`)); }
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');
  return applyPlan(db, project, cycleId, plan, areaClosedLinks);
}

/** An AreaCompletion as "Mark completed" writes it, with the coverage at this moment. */
async function complete(db, project, cycleId, area, batch, note) {
  const rows = await db.collection('linkcoverages').aggregate([
    { $match: { areaId: area._id } },
    { $group: { _id: '$firstDriverId', m: { $sum: '$lengthMeters' } } },
    { $sort: { m: -1 } },
  ]).toArray();
  const covered = rows.reduce((s, r) => s + r.m, 0);
  const top = rows.find((r) => r._id);
  const topUser = top ? await db.collection('users').findOne({ _id: top._id }, { projection: { name: 1 } }) : null;
  const now = new Date();
  await db.collection('areacompletions').updateOne(
    { projectId: project._id, coverageCycleId: cycleId, areaCode: area.areaCode },
    {
      $set: {
        status: 'completed', areaId: area._id, networkVersionId: area.networkVersionId, areaName: area.name,
        completedAt: now, completedBy: null, completedByName: 'VTS',
        completedByDriverId: topUser ? topUser._id : null, completedByDriverName: topUser ? topUser.name : null,
        coveredMeters: covered, targetMeters: area.targetMeters,
        pctAtCompletion: area.targetMeters > 0 ? (covered / area.targetMeters) * 100 : 0,
        note, reopenedAt: null, reopenedBy: null, reopenReason: null, importBatchId: batch, updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

async function applyPlan(db, project, cycleId, plan, areaClosedLinks) {
  const workAreaSplit = require('../services/workAreaSplit');
  const batch = `vtsexact-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date();
  log(`\nApplying as batch ${batch}`);

  for (const { a } of plan.complete) {
    await complete(db, project, cycleId, a, batch, 'Closed in VTS — its roads are on ground VTS closed');
  }
  log(`  completed ${plan.complete.length} areas`);

  let cuts = 0;
  for (const { a, inside, comp } of plan.cut) {
    // The closed part's outline: the VTS polygons inside it, one polygon per ring.
    const cutGeometry = { type: 'MultiPolygon', coordinates: inside.flatMap(({ v }) => v.rings.map((r) => {
      const ring = r.slice();
      if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]);
      return [ring];
    })) };
    // Completed whole by a VTS sync, but some of its roads are open on VTS: that completion is set
    // aside ('cut') so the area can be cut; --undo puts it back.
    if (comp) await db.collection('areacompletions').updateOne({ _id: comp._id }, { $set: { status: 'cut', cutBatchId: batch, updatedAt: now } });
    try {
      const res = await workAreaSplit.cutCommittedArea({
        versionId: a.networkVersionId, areaId: a._id, linkIds: [...areaClosedLinks.get(String(a._id))], cutGeometry,
        names: { cut: `${a.name} — closed in VTS`, rest: `${a.name} — open` }, tag: batch, apply: true,
      });
      const closedZone = await db.collection('workareas').findOne({ _id: res.zones[0]._id });
      await complete(db, project, cycleId, closedZone, batch, `Closed in VTS: ${inside.map(({ v }) => v.name).join(', ')}`);
      cuts++;
      log(`  cut ${a.name}: ${res.zones[0].km.toFixed(1)} km closed / ${res.zones[1].km.toFixed(1)} km open`);
    } catch (err) {
      if (comp) await db.collection('areacompletions').updateOne({ _id: comp._id }, { $set: { status: 'completed' }, $unset: { cutBatchId: '' } });
      log(`  NOT cut ${a.name} [${a.areaCode}]: ${err.message}`);
    }
  }

  for (const { a, comp } of plan.reopen) {
    await db.collection('areacompletions').updateOne(
      { _id: comp._id },
      { $set: { status: 'reopened', reopenedAt: now, reopenedBy: null, reopenReason: 'its ground is not closed on VTS (name match corrected)', reopenBatchId: batch, updatedAt: now } }
    );
    // The name match had released whoever held it; give it back if nobody holds it now.
    const nowHeld = await db.collection('areaassignments').countDocuments({ projectId: project._id, areaCode: a.areaCode, releasedAt: null });
    if (!nowHeld) {
      await db.collection('areaassignments').updateMany(
        { projectId: project._id, areaCode: a.areaCode, releaseBatchId: comp.importBatchId },
        [{ $set: { restoredBatchId: batch, priorReleasedAt: '$releasedAt', priorReleaseBatchId: '$releaseBatchId', releasedAt: null, releasedBy: null } }, { $unset: ['releaseBatchId', 'releaseReason'] }]
      );
    }
  }
  log(`  reopened ${plan.reopen.length} areas`);
  log(`Done: ${plan.complete.length} completed, ${cuts}/${plan.cut.length} cut, ${plan.reopen.length} reopened.`);
  log(`Undo: node src/seed/exactVtsClosedAreas.js --undo=${batch} --apply`);
}

async function undo(db, batch) {
  const comps = await db.collection('areacompletions').countDocuments({ importBatchId: batch });
  const reopened = await db.collection('areacompletions').countDocuments({ reopenBatchId: batch });
  const restored = await db.collection('areaassignments').countDocuments({ restoredBatchId: batch });
  const cuts = await db.collection('areasplits').find({ placesSource: batch, status: 'applied' }).toArray();
  log(`Batch ${batch}: ${comps} completions, ${reopened} reopened, ${restored} assignments given back, ${cuts.length} cut areas`);
  if (!APPLY) return log('Dry run — add --apply.');
  await db.collection('areacompletions').deleteMany({ importBatchId: batch });
  await db.collection('areacompletions').updateMany({ reopenBatchId: batch }, { $set: { status: 'completed', reopenedAt: null, reopenReason: null }, $unset: { reopenBatchId: '' } });
  await db.collection('areaassignments').updateMany(
    { restoredBatchId: batch },
    [{ $set: { releasedAt: '$priorReleasedAt', releaseBatchId: '$priorReleaseBatchId' } }, { $unset: ['restoredBatchId', 'priorReleasedAt', 'priorReleaseBatchId'] }]
  );
  const workAreaSplit = require('../services/workAreaSplit');
  for (const r of cuts) {
    await workAreaSplit.joinSplitArea({ versionId: r.networkVersionId, areaCode: r.areaCode });
  }
  // The completions set aside to cut whole-completed areas come back once the areas are whole.
  await db.collection('areacompletions').updateMany({ cutBatchId: batch }, { $set: { status: 'completed' }, $unset: { cutBatchId: '' } });
  log('Undone.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
