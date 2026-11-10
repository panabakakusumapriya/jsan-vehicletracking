/**
 * Put the areas cut by exactVtsClosedAreas.js (batches "vtsexact-…") back to their original polygons.
 *
 * The cut kept each original area byte for byte (AreaSplit.parent); joinSplitArea restores it and
 * moves the roads and coverage back. What exactVtsClosedAreas --undo does not handle, this does:
 *   - a zone a manager has since given to a driver: the driver keeps it, now on the whole area;
 *   - a zone a person has since completed or reopened: kept as their verdict on the whole area
 *     (both halves completed -> the area is completed; a reopened half -> the area is open);
 *   - completions on unrelated areas in the same batch are left alone.
 * The area's sign-off goes back to what it was before the cut: completed if it was completed whole
 * (the completion set aside as status "cut"), open otherwise.
 *
 * Nothing is deleted: zone completions are set aside (status "cut", joinBatchId) and zone
 * assignments released (releaseBatchId), so the run can be audited. A JSON backup of every zone,
 * completion and assignment it touches is written before anything changes.
 *
 * DRY RUN unless --apply.   node src/seed/joinVtsCuts.js [--batch=vtsexact-…] [--apply]
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const BATCHES = args.has('batch') ? [String(args.get('batch'))] : null;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const workAreaSplit = require('../services/workAreaSplit');
  const { recomputeForAssignment } = require('../services/linkCoverage');

  const project = await db.collection('projects').findOne({ name: PROJECT_NAME });
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);
  const cycle = project.coverageCycleId || '';
  const cuts = await db.collection('areasplits').find({
    projectId: project._id, status: 'applied',
    placesSource: BATCHES ? { $in: BATCHES } : /^vtsexact-/,
  }).toArray();
  log(`Cut areas to join back: ${cuts.length}`);

  const tag = `vtsjoin-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const plans = [];
  for (const c of cuts) {
    const zones = await db.collection('workareas').find({ networkVersionId: c.networkVersionId, 'props.splitFrom.code': c.areaCode }).toArray();
    const zoneCodes = zones.map((z) => z.areaCode);
    const held = await db.collection('areaassignments').find({ areaId: { $in: zones.map((z) => z._id) }, releasedAt: null }).toArray();
    const zoneComps = await db.collection('areacompletions').find({ projectId: project._id, coverageCycleId: cycle, areaCode: { $in: zoneCodes } }).toArray();
    const setAside = await db.collection('areacompletions').findOne({ projectId: project._id, coverageCycleId: cycle, areaCode: c.areaCode, status: 'cut', cutBatchId: c.placesSource });
    const byPerson = zoneComps.filter((k) => k.importBatchId !== c.placesSource || k.reopenedAt || k.status !== 'completed');
    const allDone = zones.length > 0 && zones.every((z) => zoneComps.some((k) => k.areaCode === z.areaCode && k.status === 'completed'));
    const drivers = [...new Map(held.map((h) => [String(h.driverId), h])).values()];

    let result;
    if (drivers.length) result = 'open, assigned';            // a manager's live assignment wins
    else if (setAside) result = 'completed (as before the cut)';
    else if (allDone && byPerson.length) result = 'completed (both halves done)';
    else result = 'open (as before the cut)';
    plans.push({ c, zones, held, drivers, zoneComps, setAside, byPerson, result });
  }

  const count = {};
  plans.forEach((p) => { count[p.result] = (count[p.result] || 0) + 1; });
  log('\nAfter the join:');
  Object.entries(count).forEach(([k, n]) => log(`  ${String(n).padStart(4)}  ${k}`));
  const notable = plans.filter((p) => p.drivers.length || p.byPerson.length || p.drivers.length > 1);
  log(`\nAreas a person has touched since the cut (${notable.length}):`);
  for (const p of notable) {
    const who = p.drivers.map((d) => d.driverName).join(' + ');
    const comps = p.byPerson.map((k) => `${k.areaName}: ${k.status}${k.completedByName ? ' by ' + k.completedByName : ''}`).join('; ');
    log(`  ${p.c.areaName} -> ${p.result}${who ? ` | driver: ${who}` : ''}${comps ? ` | ${comps}` : ''}${p.setAside && p.drivers.length ? ' | was completed before the cut; left open because a driver holds it now' : ''}`);
  }
  if (plans.some((p) => p.drivers.length > 1)) log('\nWARNING: some areas have different drivers on their two halves; the first one keeps the whole area.');
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');

  // Backup of everything about to change.
  const backup = path.join(os.tmpdir(), `${tag}-backup.json`);
  fs.writeFileSync(backup, JSON.stringify(plans.map((p) => ({ split: p.c._id, areaCode: p.c.areaCode, zones: p.zones, held: p.held, zoneComps: p.zoneComps, setAside: p.setAside })), null, 0));
  log(`\nBackup: ${backup}\nApplying as ${tag}`);

  const now = new Date();
  const reassign = [];
  let joined = 0;
  for (const p of plans) {
    const { c } = p;
    try {
      if (p.held.length) {
        await db.collection('areaassignments').updateMany({ _id: { $in: p.held.map((h) => h._id) }, releasedAt: null },
          { $set: { releasedAt: now, releasedBy: null, releaseBatchId: tag, releaseReason: 'cut zones joined back into the original area' } });
      }
      if (p.zoneComps.length) {
        await db.collection('areacompletions').updateMany({ _id: { $in: p.zoneComps.map((k) => k._id) } },
          { $set: { status: 'cut', joinBatchId: tag, priorStatus: null, updatedAt: now } });
        for (const k of p.zoneComps) await db.collection('areacompletions').updateOne({ _id: k._id }, { $set: { priorStatus: k.status } });
      }
      await workAreaSplit.joinSplitArea({ versionId: c.networkVersionId, areaCode: c.areaCode });

      if (p.result.startsWith('completed (as before')) {
        await db.collection('areacompletions').updateOne({ _id: p.setAside._id }, { $set: { status: 'completed', updatedAt: now }, $unset: { cutBatchId: '' } });
      } else if (p.result.startsWith('completed (both')) {
        const person = p.byPerson.find((k) => k.status === 'completed') || p.byPerson[0];
        await db.collection('areacompletions').updateOne(
          { projectId: project._id, coverageCycleId: cycle, areaCode: c.areaCode },
          { $set: { status: 'completed', areaId: c.parent._id, networkVersionId: c.networkVersionId, areaName: c.parent.name,
            completedAt: person.completedAt || now, completedBy: person.completedBy || null, completedByName: person.completedByName || null,
            targetMeters: c.parent.targetMeters, note: 'both cut zones were completed; joined back', importBatchId: tag,
            reopenedAt: null, reopenedBy: null, reopenReason: null, updatedAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true });
      } else if (p.setAside) {
        // Completed before the cut, but a manager has a driver on it now: theirs is the later decision.
        await db.collection('areacompletions').updateOne({ _id: p.setAside._id },
          { $set: { status: 'reopened', reopenedAt: now, reopenReason: 'held by a driver when the cut was joined back', reopenBatchId: tag, updatedAt: now }, $unset: { cutBatchId: '' } });
      }

      if (p.drivers.length) {
        const d = p.drivers[0];
        await db.collection('areaassignments').insertOne({
          projectId: project._id, networkVersionId: c.networkVersionId, areaId: c.parent._id, driverId: d.driverId,
          areaName: c.parent.name, areaCode: c.areaCode, driverName: d.driverName, assignedBy: d.assignedBy || null,
          assignedAt: now, releasedAt: null, note: tag, createdAt: now, updatedAt: now,
        });
        reassign.push({ driverId: d.driverId, areaCode: c.areaCode });
      }
      joined++;
    } catch (err) {
      log(`  NOT joined ${c.areaName} [${c.areaCode}]: ${err.message}`);
      // Put back what was set aside for this area.
      if (p.held.length) await db.collection('areaassignments').updateMany({ _id: { $in: p.held.map((h) => h._id) }, releaseBatchId: tag },
        { $set: { releasedAt: null, releasedBy: null }, $unset: { releaseBatchId: '', releaseReason: '' } });
      for (const k of p.zoneComps) await db.collection('areacompletions').updateOne({ _id: k._id }, { $set: { status: k.status }, $unset: { joinBatchId: '', priorStatus: '' } });
    }
  }
  if (reassign.length) {
    log(`Re-figuring assigned UKM for ${reassign.length} driver areas…`);
    await recomputeForAssignment(project._id, reassign);
  }
  log(`Done: ${joined}/${plans.length} areas joined back (${tag}).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
