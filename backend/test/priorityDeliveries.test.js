// Deliveries by priority: one project, several deliveries on overlapping ground, each its own band.
//
// Vietnam came as FC3 in Hanoi and Ho Chi Minh (P1), FC4-5 at 7 TPA sites (P2) and FC1-2
// countrywide (P3). Hanoi holds roads of all three, and a road belongs to one area with one band, so
// the bands cannot be columns on one set of polygons: each band is its own delivery. Three things
// stood in the way, and this pins each down:
//   - roads-only uploads (zones drawn from the roads) had no .dbf to carry a band — now a PRIORITY
//     column on the ROADS makes the drawn zones that band; mixed values leave P0 and say so;
//   - every import superseded the active delivery, which then dropped off the map until somebody
//     was assigned to it — importing P2 hid P1. An import marked keepCurrent keeps it live;
//   - LINK_IDs too wide for their column arrive as "**********": read as NaN they all became one id
//     and 30 of 31 such Vietnam roads (130 km) were dropped as repeats. Now: an id from the shape.
//
// Run: node test/priorityDeliveries.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'priority_deliveries_secret_1234567890';
process.env.LEDGER_MEMO_MS = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

/* ---- a minimal road shapefile: PolyLine + LINK_ID / ST_NAME / FUNC_CLASS / PRIORITY ---- */
const FIELDS = [
  { name: 'LINK_ID', type: 'N', len: 10 },
  { name: 'ST_NAME', type: 'C', len: 20 },
  { name: 'FUNC_CLASS', type: 'C', len: 1 },
  { name: 'PRIORITY', type: 'N', len: 2 },
];
function cell(f, v) {
  const out = Buffer.alloc(f.len, 0x20);
  const s = v == null ? '' : String(v);
  if (f.type === 'N') out.write(s, f.len - s.length, 'latin1');
  else out.write(s, 0, 'latin1');
  return out;
}
function writeRoads(dir, base, roads) {
  const recs = roads.map(({ coords }) => {
    const c = Buffer.alloc(44 + 4 + 16 * coords.length);
    const xs = coords.map((p) => p[0]); const ys = coords.map((p) => p[1]);
    c.writeInt32LE(3, 0);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => c.writeDoubleLE(v, 4 + i * 8));
    c.writeInt32LE(1, 36); c.writeInt32LE(coords.length, 40); c.writeInt32LE(0, 44);
    coords.forEach(([x, y], i) => { c.writeDoubleLE(x, 48 + i * 16); c.writeDoubleLE(y, 56 + i * 16); });
    return c;
  });
  const all = roads.flatMap((r) => r.coords);
  const header = (lenBytes) => {
    const h = Buffer.alloc(100);
    h.writeInt32BE(9994, 0); h.writeInt32BE(lenBytes / 2, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(3, 32);
    [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]
      .forEach((v, i) => h.writeDoubleLE(v, 36 + i * 8));
    return h;
  };
  const shp = [header(100 + recs.reduce((s, c) => s + 8 + c.length, 0))];
  const shx = [header(100 + 8 * recs.length)];
  let offset = 100;
  recs.forEach((c, i) => {
    const rh = Buffer.alloc(8); rh.writeInt32BE(i + 1, 0); rh.writeInt32BE(c.length / 2, 4); shp.push(rh, c);
    const ix = Buffer.alloc(8); ix.writeInt32BE(offset / 2, 0); ix.writeInt32BE(c.length / 2, 4); shx.push(ix);
    offset += 8 + c.length;
  });
  fs.writeFileSync(path.join(dir, `${base}.shp`), Buffer.concat(shp));
  fs.writeFileSync(path.join(dir, `${base}.shx`), Buffer.concat(shx));
  const rl = 1 + FIELDS.reduce((s, f) => s + f.len, 0);
  const head = Buffer.alloc(32);
  head[0] = 3; head.writeUInt32LE(roads.length, 4); head.writeUInt16LE(32 + 32 * FIELDS.length + 1, 8); head.writeUInt16LE(rl, 10);
  const descs = FIELDS.map((f) => { const d = Buffer.alloc(32); d.write(f.name, 0, 'latin1'); d[11] = f.type.charCodeAt(0); d[16] = f.len; return d; });
  const rows = roads.map((r) => Buffer.concat([Buffer.from(' '), ...FIELDS.map((f) => {
    if (f.name === 'LINK_ID' && r.id === 'overflow') return Buffer.from('*'.repeat(f.len));
    return cell(f, { LINK_ID: r.id, ST_NAME: r.name || '', FUNC_CLASS: r.fc, PRIORITY: r.priority }[f.name]);
  })]));
  fs.writeFileSync(path.join(dir, `${base}.dbf`), Buffer.concat([head, ...descs, Buffer.from([0x0d]), ...rows, Buffer.from([0x1a])]));
  fs.writeFileSync(path.join(dir, `${base}.prj`), 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
}
async function zipOf(dir, base) {
  const archiver = require('archiver');
  const out = path.join(dir, `${base}.zip`);
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out);
    const zip = archiver('zip');
    stream.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(stream);
    for (const ext of ['shp', 'shx', 'dbf', 'prj']) zip.file(path.join(dir, `${base}.${ext}`), { name: `${base}.${ext}` });
    zip.finalize();
  });
  return out;
}
/** A little street grid: `n` east-west roads ~2.2 km long, 300 m apart, starting at (lon, lat). */
const grid = (lon, lat, n, props) => Array.from({ length: n }, (_, i) => ({
  id: 9000000 + Math.round(lon * 1000) + i * 7 + Math.round(lat * 100),
  name: `Street ${i + 1}`,
  coords: [[lon, lat + i * 0.0027], [lon + 0.01, lat + i * 0.0027], [lon + 0.02, lat + i * 0.0027]],
  ...props(i),
}));

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('priority_deliveries_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const runner = require('../src/services/importRunner');
  runner.kickImportRunner = () => {};
  const { createApp } = require('../src/app');
  const { DbfReader } = require('../src/utils/shapefile');
  const { liveNetworkVersions } = require('../src/services/liveNetworks');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const ImportJob = require('../src/models/ImportJob');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  await WorkArea.init();
  const app = createApp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'priority-deliveries-'));

  const project = await Project.create({ name: 'Vietnam (test)' });
  const boss = new User({ name: 'boss', email: 'boss@x.com', role: 'admin', projectIds: [project._id] });
  await boss.setPassword('pw123456'); await boss.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'boss@x.com', password: 'pw123456' })).body.token;
  const as = (q) => q.set('Authorization', `Bearer ${token}`);

  async function importRoads(label, base, roads, { keepCurrent = false } = {}) {
    writeRoads(tmp, base, roads);
    const zip = await zipOf(tmp, base);
    const job = (await as(request(app).post('/api/network/imports')).send({ projectId: project._id, label, keepCurrent })).body.job;
    await as(request(app).patch(`/api/network/imports/${job._id}`)).send({ drawZones: { minKm: 5, maxKm: 10 } });
    await as(request(app).post(`/api/network/imports/${job._id}/file?layer=network&hold=1`)).set('Content-Type', 'application/zip').send(fs.readFileSync(zip));
    await as(request(app).post(`/api/network/imports/${job._id}/validate`)).send({});
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      if ((await ImportJob.findById(job._id).lean()).status === 'ready') break;
      // eslint-disable-next-line no-await-in-loop
      await runner.tick();
    }
    const done = await ImportJob.findById(job._id).lean();
    if (done.status !== 'ready') throw new Error(`${label}: import ${done.status} — ${done.error || JSON.stringify(done.report?.errors)}`);
    return { job: done, version: await NetworkVersion.findById(done.networkVersionId).lean() };
  }
  const bandsOf = async (version) => [...new Set((await WorkArea.find({ networkVersionId: version._id }).select('priority').lean()).map((a) => a.priority))];
  const isLive = async (version) => (await liveNetworkVersions([project._id])).some((v) => String(v._id) === String(version._id));

  console.log('\n-- a LINK_ID too wide for its column --');
  writeRoads(tmp, 'probe', grid(105.80, 21.00, 2, (i) => ({ fc: '3', priority: 1, id: i === 0 ? 'overflow' : 1234 })));
  const dbf = new DbfReader(path.join(tmp, 'probe.dbf'));
  assert(dbf.record(0).LINK_ID === null, '"**********" reads as no value, not NaN');
  assert(dbf.record(1).LINK_ID === 1234, 'an ordinary id still reads as its number');
  dbf.close();

  // Before: the one delivery uploaded first, every road class in it — superseded by P1, as it should be.
  const mixedFirst = await NetworkVersion.create({ projectId: project._id, label: 'Vietnam (all classes, P0)', status: 'active', targetMeters: 1, counts: { areas: 1, links: 1, orphanLinks: 0 } });

  console.log('\n-- P1: FC3 roads, PRIORITY=1, three of them with unreadable ids --');
  const p1Roads = grid(105.80, 21.00, 12, (i) => ({ fc: '3', priority: 1, ...(i < 3 ? { id: 'overflow' } : {}) }));
  const p1 = await importRoads('Vietnam P1', 'p1_fc3', p1Roads);
  assert(JSON.stringify(await bandsOf(p1.version)) === '[1]', 'every zone drawn from the P1 roads is P1');
  assert(p1.job.report.drawn.priority === 1 && p1.job.report.drawn.priorityFrom === 'PRIORITY', 'the report says the band came from the roads\' PRIORITY column');
  assert((await RoadLink.countDocuments({ networkVersionId: p1.version._id })) === 12, 'all 12 roads are in — the three unreadable ids were not merged into one');
  assert(!p1.job.report.warnings.some((w) => w.code === 'DUPLICATE_LINK_ID'), 'and nothing was dropped as a repeat');
  assert((await RoadLink.distinct('priority', { networkVersionId: p1.version._id })).join() === '1', 'each road carries the band too (what the coverage ledger copies)');
  assert(!(await isLive(mixedFirst)), 'P1 (not marked "adds") replaced the earlier all-classes delivery: it is off the map');

  console.log('\n-- P2: other roads, PRIORITY=2, marked "adds to the project" --');
  const p2 = await importRoads('Vietnam P2', 'p2_fc45', grid(106.65, 10.80, 10, () => ({ fc: '5', priority: 2 })), { keepCurrent: true });
  assert(JSON.stringify(await bandsOf(p2.version)) === '[2]', 'P2 zones are P2');
  const p1After = await NetworkVersion.findById(p1.version._id).lean();
  assert(p1After.status === 'superseded' && p1After.keepLive === true, 'P1 is superseded but kept live');
  assert(await isLive(p1.version), 'so P1 is still one of the project\'s deliveries, before anyone is assigned to it');
  assert(await isLive(p2.version), 'beside P2, the active one');
  const listed = (await as(request(app).get(`/api/network/versions?projectId=${project._id}`))).body.versions;
  assert(listed.filter((v) => v.live).map((v) => v.label).sort().join() === 'Vietnam P1,Vietnam P2', 'the panel offers both — and not the replaced all-classes copy');
  const summary = (await as(request(app).get(`/api/network/versions/${project._id}`))).body;
  const bands = (summary.coverage?.byPriority || []).map((b) => b.priority).sort();
  assert(bands.join() === '1,2', 'the Coverage page totals the project by P1 and P2');

  console.log('\n-- mixed bands in one roads file --');
  const mixed = await importRoads('Mixed', 'mixed', grid(108.20, 16.05, 6, (i) => ({ fc: '2', priority: i % 2 ? 3 : 1 })));
  assert(JSON.stringify(await bandsOf(mixed.version)) === '[0]', 'roads of two bands cannot make one zone\'s band: P0');
  assert(mixed.job.report.warnings.some((w) => w.code === 'MIXED_ROAD_PRIORITY' && /P1: 3 roads, P3: 3 roads/.test(w.message)), 'and the report says why, band by band');
  assert(!(await isLive(p2.version)), 'not marked "adds": it replaced P2, which had no work on it yet');
  assert(await isLive(p1.version), 'P1, kept live earlier, stays');

  console.log('\n-- deleting an import takes back what it loaded --');
  const AreaAssignment = require('../src/models/AreaAssignment');
  // A roads-only upload that JOINED a delivery's areas did not make that delivery.
  const joined = await ImportJob.create({ projectId: project._id, requestedBy: boss._id, label: 'Roads added', status: 'ready', networkVersionId: p1.version._id });
  const keptJoined = (await as(request(app).delete(`/api/network/imports/${joined._id}`))).body;
  assert(keptJoined.ok && !keptJoined.delivery.removed, 'an upload that only added roads never takes the delivery with it');
  assert(await NetworkVersion.exists({ _id: p1.version._id }), 'P1 is untouched');

  const gone = (await as(request(app).delete(`/api/network/imports/${mixed.job._id}`))).body;
  assert(gone.ok && gone.delivery.removed && gone.delivery.areas >= 1, 'deleting the unused "Mixed" import removes its delivery too');
  assert(!(await NetworkVersion.exists({ _id: mixed.version._id })), 'the delivery is gone');
  assert((await WorkArea.countDocuments({ networkVersionId: mixed.version._id })) === 0
    && (await RoadLink.countDocuments({ networkVersionId: mixed.version._id })) === 0, 'and so are its work areas and roads');
  assert(gone.delivery.reactivated === 'Vietnam P1', 'it was the active one: the newest delivery still in use (P1) is active again');
  assert((await NetworkVersion.findById(p1.version._id).lean()).status === 'active', 'P1 is the active delivery');
  assert(!(await NetworkVersion.exists({ _id: p2.version._id, status: 'active' })), 'not the abandoned P2, which nothing used');

  const p1Area = await WorkArea.findOne({ networkVersionId: p1.version._id }).lean();
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: p1.version._id, areaId: p1Area._id, areaCode: p1Area.areaCode,
    areaName: p1Area.name, driverId: boss._id, driverName: 'boss', assignedBy: boss._id, assignedAt: new Date(),
  });
  const kept = (await as(request(app).delete(`/api/network/imports/${p1.job._id}`))).body;
  assert(kept.ok && !kept.delivery.removed && /assigned/.test(kept.delivery.reason), 'an import whose areas have been assigned: the record goes, the areas stay, and it says why');
  assert((await WorkArea.countDocuments({ networkVersionId: p1.version._id })) > 0, 'P1\'s areas are all still there');

  console.log(`\n🎉 PRIORITY DELIVERIES — ${passed} assertions passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
