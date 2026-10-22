/**
 * Mirror the area assignments drivers hold on the old VTS app into Atlas ops.
 *
 * On VTS each driver's assigned geofence ("Assigned areas (N) — <driver>") is built from N named
 * area geofences (metadata.sourceGeofenceIds) — the same ABS regions the deliveries here are cut
 * into ("Moyne - East", "Woodend", …, each with its code). So each VTS area is matched to a work
 * area of the project's live deliveries by name, confirmed by place: the VTS polygon's centre must
 * fall inside the matched area's bbox (Victoria's "Emerald - Cockatoo" is not Queensland's
 * "Emerald"), and when a name occurs twice the area that holds the centre wins.
 *
 * The panel's own rules apply, as in network.controller bulkAssign:
 *   - one polygon, one driver: an area another driver already holds here, or that VTS gives to two
 *     drivers, is NOT assigned — listed for a manager to settle;
 *   - an area signed off as completed is not reassigned;
 *   - the driver must be on the project (matched by email).
 * Assigned areas get the usual follow-up: the drivers' earlier driving inside them becomes their
 * assigned UKM (linkCoverage.recomputeForAssignment).
 *
 * Read-only on VTS (VTS_MONGODB_URI, queries only). DRY RUN unless --apply. Every row written
 * carries note "vts-assign:<batch>"; --revert=<batch> releases exactly those.
 *
 * Usage
 *   VTS_MONGODB_URI=… node src/seed/mirrorVtsAssignments.js [--apply]
 *   node src/seed/mirrorVtsAssignments.js --revert=<vts-assign-…> --apply
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785'); // "projaustralia"
const APPLY = args.get('apply') === true;
const REVERT = args.has('revert') ? String(args.get('revert')) : null;
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
const log = (...a) => console.log(...a);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*-\s*/g, ' - ').trim();

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const AreaAssignment = require('../models/AreaAssignment');
  if (REVERT) {
    const n = await AreaAssignment.countDocuments({ note: `vts-assign:${REVERT}`, releasedAt: null });
    log(`Batch ${REVERT}: ${n} live assignments`);
    if (!APPLY) return log('Dry run — add --apply to release them.');
    const r = await AreaAssignment.updateMany({ note: `vts-assign:${REVERT}`, releasedAt: null }, { $set: { releasedAt: new Date() } });
    return log(`Released ${r.modifiedCount}.`);
  }
  if (!process.env.VTS_MONGODB_URI) throw new Error('VTS_MONGODB_URI is required (read-only VTS database)');

  const { MongoClient, ObjectId } = mongoose.mongo;
  const Project = require('../models/Project');
  const User = require('../models/User');
  const WorkArea = require('../models/WorkArea');
  const AreaCompletion = require('../models/AreaCompletion');
  const { liveNetworkVersions } = require('../services/liveNetworks');
  const { recomputeForAssignment } = require('../services/linkCoverage');

  const project = await Project.findOne({ name: PROJECT_NAME }).select('_id coverageCycleId').lean();
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);
  const live = (await liveNetworkVersions([project._id])).filter((v) => String(v.projectId) === String(project._id));
  const areas = await WorkArea.find({ networkVersionId: { $in: live.map((v) => v._id) } }).select('name areaCode networkVersionId bbox').lean();
  const byName = new Map();
  for (const a of areas) {
    const k = norm(a.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }
  log(`Atlas: ${live.length} live deliveries, ${areas.length} work areas`);

  // --- VTS: who holds which areas -----------------------------------------------------------
  const client = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await client.connect();
  const vts = client.db();
  const wants = []; // { email, driverName, vtsArea, centre }
  try {
    const users = await vts.collection('users').find({ project: new ObjectId(VTS_PROJECT) }, { projection: { name: 1, email: 1, assignedGeofence: 1 } }).toArray();
    for (const u of users) {
      if (!u.assignedGeofence || TEST_EMAILS.has(String(u.email).toLowerCase())) continue;
      const g = await vts.collection('geofences').findOne({ _id: new ObjectId(String(u.assignedGeofence)) }, { projection: { 'metadata.sourceGeofenceIds': 1 } });
      const ids = (g && g.metadata && g.metadata.sourceGeofenceIds) || [];
      const src = await vts.collection('geofences').find({ _id: { $in: ids.map((x) => new ObjectId(String(x))) } }, { projection: { name: 1, polygon: 1, bounds: 1 } }).toArray();
      for (const s of src) {
        const pts = Array.isArray(s.polygon) ? s.polygon : [];
        let lat = 0, lon = 0;
        for (const p of pts) { lat += p.lat; lon += p.lng; }
        const centre = pts.length ? [lon / pts.length, lat / pts.length] : null;
        wants.push({ email: String(u.email).toLowerCase(), driverName: u.name, vtsArea: s.name, centre });
      }
    }
  } finally {
    await client.close();
  }
  log(`VTS: ${new Set(wants.map((w) => w.email)).size} drivers hold ${wants.length} area assignments`);

  // --- match, then apply the panel's rules ----------------------------------------------------
  const drivers = await User.find({ role: 'user', projectIds: project._id }).select('_id name email').lean();
  const driverByEmail = new Map(drivers.map((d) => [String(d.email).toLowerCase(), d]));
  const inBox = (c, b) => c && b && c[0] >= b[0] - 0.02 && c[0] <= b[2] + 0.02 && c[1] >= b[1] - 0.02 && c[1] <= b[3] + 0.02;

  const unmatched = [];
  const noDriver = new Map();
  const claims = new Map(); // areaId -> [{ area, driver }]
  for (const w of wants) {
    const driver = driverByEmail.get(w.email);
    if (!driver) { noDriver.set(w.driverName, (noDriver.get(w.driverName) || 0) + 1); continue; }
    const cands = (byName.get(norm(w.vtsArea)) || []).filter((a) => !w.centre || inBox(w.centre, a.bbox));
    if (!cands.length) { unmatched.push(`${w.vtsArea} (${w.driverName})`); continue; }
    for (const area of cands) {
      const k = String(area._id);
      if (!claims.has(k)) claims.set(k, []);
      if (!claims.get(k).some((c) => String(c.driver._id) === String(driver._id))) claims.get(k).push({ area, driver });
    }
  }

  const areaIds = [...claims.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const current = await AreaAssignment.find({ areaId: { $in: areaIds }, releasedAt: null }).select('areaId driverId driverName').lean();
  const heldBy = new Map(current.map((r) => [String(r.areaId), r]));
  const completed = new Set((await AreaCompletion.find({ projectId: project._id, coverageCycleId: project.coverageCycleId || '', status: 'completed' }).select('areaCode').lean()).map((c) => c.areaCode));

  const plan = [];
  const already = [];
  const twoInVts = [];
  const heldByOther = [];
  const signedOff = [];
  for (const [areaId, list] of claims) {
    const { area } = list[0];
    const label = `${area.name} [${area.areaCode}]`;
    if (list.length > 1) { twoInVts.push(`${label}: ${list.map((c) => c.driver.name).join(' + ')}`); continue; }
    const { driver } = list[0];
    const holder = heldBy.get(areaId);
    if (holder && String(holder.driverId) === String(driver._id)) { already.push(label); continue; }
    if (holder) { heldByOther.push(`${label}: held by ${holder.driverName} here, ${driver.name} on VTS`); continue; }
    if (completed.has(area.areaCode)) { signedOff.push(`${label} (${driver.name})`); continue; }
    plan.push({ area, driver });
  }

  const perDriver = {};
  for (const p of plan) perDriver[p.driver.name] = (perDriver[p.driver.name] || 0) + 1;
  log(`\nTo assign: ${plan.length} areas`);
  for (const [n, c] of Object.entries(perDriver).sort((a, b) => b[1] - a[1])) log(`  ${String(c).padStart(3)}  ${n}`);
  log(`Already assigned to the same driver here: ${already.length}`);
  if (twoInVts.length) { log(`\nNot assigned — VTS gives one area to two drivers (${twoInVts.length}):`); twoInVts.forEach((x) => log(`  ${x}`)); }
  if (heldByOther.length) { log(`\nNot assigned — another driver holds it here (${heldByOther.length}):`); heldByOther.forEach((x) => log(`  ${x}`)); }
  if (signedOff.length) { log(`\nNot assigned — area signed off as completed (${signedOff.length}):`); signedOff.forEach((x) => log(`  ${x}`)); }
  if (unmatched.length) { log(`\nNo matching area in the live deliveries (${unmatched.length}):`); log(`  ${unmatched.join(' | ')}`); }
  if (noDriver.size) { log('\nVTS drivers with no account on the project:'); for (const [n, c] of noDriver) log(`  ${n}: ${c} areas`); }
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');
  if (!plan.length) return log('Nothing to assign.');

  const batch = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date();
  await AreaAssignment.insertMany(plan.map(({ area, driver }) => ({
    projectId: project._id, networkVersionId: area.networkVersionId, areaId: area._id,
    driverId: driver._id, areaName: area.name, areaCode: area.areaCode, driverName: driver.name,
    assignedBy: null, assignedAt: now, note: `vts-assign:${batch}`,
  })), { ordered: false }).catch((err) => { if (err && err.code !== 11000) throw err; });
  log(`\nAssigned ${plan.length} areas (batch ${batch}). Re-figuring the drivers' earlier driving inside them…`);
  await recomputeForAssignment(project._id, plan.map(({ area, driver }) => ({ driverId: driver._id, areaCode: area.areaCode })));
  log(`Done. Undo: node src/seed/mirrorVtsAssignments.js --revert=${batch} --apply`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
