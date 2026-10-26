/**
 * Import a roads-only delivery (no work-area polygons) with zones drawn from the roads — the same
 * job the panel's "Draw zones from the roads" runs, for use from here before that panel is live.
 *
 * The zip may hold one road shapefile, several (one per road class), or several zips of them.
 * Runs only the job it creates: the job is made already held by this script, so no server's import
 * runner can take it, and nothing else in the queue is touched.
 *
 * DRY RUN unless --apply.
 *
 * Usage
 *   node src/seed/importRoadsAsZones.js --zip=<file.zip> --project="<name>" [--create --country="New Zealand"]
 *        [--min=250 --max=300] [--leftover=separate] [--label="…"] [--apply]
 */
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => { const [k, ...r] = a.replace(/^--/, '').split('='); return [k, r.length ? r.join('=') : true]; }));
const APPLY = args.get('apply') === true;
const log = (...a) => console.log(...a);

async function main() {
  const zip = String(args.get('zip') || '');
  const projectName = String(args.get('project') || '').trim();
  if (!zip || !fs.existsSync(zip)) throw new Error('--zip=<file.zip> is required and must exist');
  if (!projectName) throw new Error('--project="<name>" is required');
  const minKm = Number(args.get('min') || 250);
  const maxKm = Number(args.get('max') || 300);
  const absorbRemainder = args.get('leftover') !== 'separate';

  await connectDB();
  const Project = require('../models/Project');
  const User = require('../models/User');
  const ImportJob = require('../models/ImportJob');
  const WorkArea = require('../models/WorkArea');
  const NetworkVersion = require('../models/NetworkVersion');
  const fileStore = require('../utils/fileStore');
  const workAreaSplit = require('../services/workAreaSplit');
  const { tick } = require('../services/importRunner');
  workAreaSplit.optionsFrom({ minKm, maxKm }); // a bad size fails here, before anything is written

  let project = await Project.findOne({ name: projectName });
  log(`Database: ${mongoose.connection.host}`);
  log(`Project: ${project ? `${project.name} (${project._id})` : `"${projectName}" — does not exist${args.get('create') ? ', will be created' : ''}`}`);
  if (!project && !args.get('create')) throw new Error('No such project — add --create to make it');
  if (project) {
    const versions = await NetworkVersion.countDocuments({ projectId: project._id });
    if (versions) log(`  it already has ${versions} network deliveries; this one becomes the active one, the others stay as they are`);
  }
  const admin = await User.findOne({ role: 'superadmin' }).select('_id email').lean();
  log(`Zip: ${zip} (${(fs.statSync(zip).size / 1e6).toFixed(1)} MB) · zones ${minKm}–${maxKm} km · leftover ${absorbRemainder ? 'shared out' : 'a zone of its own'}`);
  if (!APPLY) { log('\nDry run — nothing written. Add --apply.'); return; }

  if (!project) {
    project = await Project.create({ name: projectName, code: args.get('code') || null, country: args.get('country') || null });
    log(`Created project ${project.name} (${project._id})`);
  }
  const stored = await fileStore.putStream(fs.createReadStream(zip), {
    filename: zip.split(/[\\/]/).pop(),
    metadata: { layer: 'network', projectId: String(project._id) },
  });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const hold = `script-${crypto.randomUUID()}`;
  const job = await ImportJob.create({
    projectId: project._id,
    requestedBy: admin._id,
    label: String(args.get('label') || `${project.name} roads`),
    status: 'queued',
    claimToken: hold,
    claimedAt: new Date(),
    files: { network: { name: zip.split(/[\\/]/).pop(), bytes: stored.bytes, fileId: stored.id, sha256, uploadedAt: new Date() } },
    drawZones: { minKm, maxKm, absorbRemainder },
  });
  log(`Import job ${job._id} — running`);
  const t = Date.now();
  await tick({ jobId: job._id, heldBy: hold });
  const done = await ImportJob.findById(job._id).lean();
  log(`Job ${done.status} in ${((Date.now() - t) / 1000).toFixed(0)} s${done.error ? ` — ${done.error}` : ''}`);
  if (done.status !== 'ready') {
    for (const e of done.report?.errors || []) log(`  ! ${e.message}`);
    return;
  }
  log(`Roads: ${done.report.totals.links.toLocaleString()} links, ${(done.report.network.totalMeters / 1000).toFixed(0)} km from ${(done.report.network.layers || [{ name: done.report.network.file }]).map((l) => l.name).join(', ')}`);
  log(`Drawn area: ${done.report.drawn?.name} — ${done.report.drawn?.pieces} piece(s)`);
  log(`Zones: ${JSON.stringify(done.drawZonesResult)}`);
  const zones = await WorkArea.find({ networkVersionId: done.networkVersionId }).select('areaCode name targetMeters').sort({ areaCode: 1 }).lean();
  for (const z of zones) log(`  ${z.areaCode}  ${z.name.padEnd(28)} ${(z.targetMeters / 1000).toFixed(0)} km`);
  // The coverage map's road file, now rather than on the first visit.
  await require('../services/roadBlobs').warm([done.networkVersionId]).catch((e) => log(`road file: ${e.message}`));
  log('Done.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
