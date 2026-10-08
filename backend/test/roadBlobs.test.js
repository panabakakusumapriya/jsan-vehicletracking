// The coverage map's road files: services/roadBlobs.js, GET /road-blob, /road-blobs, /road-state.
//
// Every road of a delivery at full detail in one cached binary file, so the map can draw the whole
// network at once instead of a screenful at a time past a zoom level. Under test: the file decodes
// to exactly the roads in the database (every vertex, ≈0.1 m), in the order the coverage state
// relies on; numeric and non-numeric link ids; the key changes when the delivery does; the coverage
// state names the right links and drivers; who may read what.
//
// Run: node test/roadBlobs.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'road_blobs_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

/** The panel's decoder, in miniature: gunzipped bytes -> header + typed arrays. */
function decode(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RDB1') throw new Error('bad magic');
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen).replace(/\0+$/, '').trim());
  const data = 8 + headerLen;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const sec = (name, Type) => {
    const [off, len] = header.sections[name];
    return new Type(ab, data + off, len / Type.BYTES_PER_ELEMENT);
  };
  const starts = sec('starts', Uint32Array);
  const coords = sec('coords', Int32Array);
  const lines = [];
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < header.linkCount; i++) {
    const line = [];
    for (let v = starts[i]; v < starts[i + 1]; v++) {
      lon += coords[v * 2];
      lat += coords[v * 2 + 1];
      line.push([lon / header.scale, lat / header.scale]);
    }
    lines.push(line);
  }
  const ids = header.ids || Array.from(sec('ids', Float64Array), String);
  return { header, lines, ids, fc: sec('fc', Uint8Array), area: sec('area', Uint16Array) };
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('road_blobs_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const zlib = require('zlib');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const AreaCompletion = require('../src/models/AreaCompletion');
  const { lineLength } = require('../src/utils/geo');
  await Promise.all([WorkArea.init(), RoadLink.init(), LinkCoverage.init()]);
  const app = createApp();

  const project = await Project.create({ name: 'HE Drive' });
  const other = await Project.create({ name: 'Elsewhere' });
  const v1 = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'active' });
  const v2 = await NetworkVersion.create({ projectId: project._id, label: 'osm', status: 'superseded' });
  const box = { type: 'Polygon', coordinates: [[[174.7, -36.9], [174.8, -36.9], [174.8, -36.8], [174.7, -36.8], [174.7, -36.9]]] };
  const west = await WorkArea.create({ projectId: project._id, networkVersionId: v1._id, areaCode: 'W', name: 'Westside', geometry: box, bbox: [174.7, -36.9, 174.8, -36.8] });
  const east = await WorkArea.create({ projectId: project._id, networkVersionId: v1._id, areaCode: 'E', name: 'Eastside', geometry: box, bbox: [174.7, -36.9, 174.8, -36.8] });

  // Ids chosen so string order differs from numeric order: "10" < "100" < "9".
  const mk = (v, linkId, coords, area, fc) => RoadLink.create({
    projectId: project._id, networkVersionId: v._id, linkId, dirTravel: 'B', funcClass: fc,
    areaId: area ? area._id : null, areaCode: area ? area.areaCode : null,
    geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords),
  });
  const precise = [[174.7612345678, -36.8512345678], [174.7623456789, -36.8523456789], [174.7634567891, -36.8534567891], [174.7645678912, -36.8545678912]];
  await mk(v1, '9', [[174.71, -36.81], [174.72, -36.82]], east, 5);
  await mk(v1, '100', precise, west, 3);
  await mk(v1, '10', [[174.73, -36.83], [174.731, -36.831], [174.732, -36.832]], null, 4);
  await mk(v2, 'osm-7', [[78.4, 17.4], [78.41, 17.41]], null, 5);
  await mk(v2, 'osm-12', [[78.42, 17.42], [78.43, 17.43]], null, 5);

  const mkUser = async (name, role, p = project) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [p._id] });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const ravi = await mkUser('ravi', 'user');
  const stranger = await mkUser('stranger', 'manager', other);

  // The HTTP client unzips by itself; the stored bytes are gzip either way.
  const unzip = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
  /** base64 -> Uint32 values. Copied out: a small Buffer is a view into a shared pool. */
  const u32 = (b64) => { const b = Buffer.from(b64, 'base64'); return Array.from(new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))); };
  const get = (who, path) => who.as(request(app).get(`/api/network${path}`));
  const fetchBlob = async (versionId, key) => {
    const res = await get(boss, `/road-blob/${versionId}/${key}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return res;
  };

  /* ── the list of files ── */
  const list = await get(boss, `/versions/${project._id}/road-blobs`);
  const byVersion = new Map(list.body.blobs.map((b) => [b.versionId, b]));
  assert(list.status === 200 && byVersion.size === 1 && byVersion.get(String(v1._id)).links === 3,
    'the project lists the road files of its live deliveries (the superseded one with nothing on it is not live)');
  const k1 = byVersion.get(String(v1._id)).key;

  /* ── the file ── */
  const res = await fetchBlob(v1._id, k1);
  assert(res.status === 200 && res.headers['content-encoding'] === 'gzip' && /immutable/.test(res.headers['cache-control']),
    'the file comes gzipped, cacheable for good under its key');
  const blob = decode(unzip(res.body));
  assert(blob.header.linkCount === 3 && blob.header.vertexCount === 9, 'it holds every link and every vertex (3 links, 9 vertices)');
  assert(blob.ids.join() === '10,100,9', 'links are in link-id order as the index sorts them (as strings: 10, 100, 9)');
  const p = blob.lines[1];
  const err = Math.max(...p.flatMap(([x, y], i) => [Math.abs(x - precise[i][0]), Math.abs(y - precise[i][1])]));
  assert(p.length === 4 && err <= 0.5e-6, `no simplification: all 4 vertices of link 100, each within 0.5 µ° (≈5 cm) — worst ${err.toExponential(1)}`);
  assert(blob.fc[0] === 4 && blob.fc[1] === 3 && blob.fc[2] === 5, 'each link keeps its functional class');
  const areaName = (i) => (blob.area[i] === 65535 ? null : blob.header.areas[blob.area[i]].name);
  assert(areaName(0) === null && areaName(1) === 'Westside' && areaName(2) === 'Eastside', 'each link names its area; a link in none says so');
  const again = await fetchBlob(v1._id, k1);
  assert(again.status === 200 && Buffer.compare(again.body, res.body) === 0, 'asked again, it is served from storage — the same bytes');

  /* ── non-numeric ids ── */
  const k2 = (await get(boss, `/versions/${v2._id}/road-blobs`)).body.blobs[0].key;
  const osm = decode(unzip((await fetchBlob(v2._id, k2)).body));
  assert(osm.ids.join() === 'osm-12,osm-7' && osm.lines[1][0][0] === 78.4, 'ids that are not plain numbers travel as text, in the same order');

  /* ── the key follows the content ── */
  await mk(v1, '200', [[174.74, -36.84], [174.75, -36.85]], west, 5);
  const k1b = (await get(boss, `/versions/${v1._id}/road-blobs`)).body.blobs[0].key;
  assert(k1b !== k1, 'a road added (a roads-only import) gives the file a new key');
  assert((await fetchBlob(v1._id, k1)).status === 410, 'the old key answers 410 Gone, so the map asks for the list again');
  await WorkArea.create({ projectId: project._id, networkVersionId: v1._id, areaCode: 'W-01', name: 'Westside 01', geometry: box });
  const k1c = (await get(boss, `/versions/${v1._id}/road-blobs`)).body.blobs[0].key;
  assert(k1c !== k1b, 'and so does a change of areas (a split or a join)');
  const fresh = decode(unzip((await fetchBlob(v1._id, k1c)).body));
  assert(fresh.ids.join() === '10,100,200,9' && fresh.header.areas.length === 3, 'the new file has the new road and the new area');

  /* ── coverage state ── */
  const trip = new mongoose.Types.ObjectId();
  await LinkCoverage.create({ projectId: project._id, networkVersionId: v1._id, linkId: '9', lengthMeters: 100, areaId: east._id, firstTripId: trip, firstDriverId: ravi.user._id, firstAt: new Date() });
  await LinkCoverage.create({ projectId: project._id, networkVersionId: v1._id, linkId: '200', lengthMeters: 100, areaId: west._id, firstTripId: trip, firstDriverId: ravi.user._id, firstAt: new Date() });
  await LinkCoverage.create({ projectId: project._id, networkVersionId: v1._id, linkId: 'gone', lengthMeters: 1, firstTripId: trip, firstDriverId: ravi.user._id, firstAt: new Date() });
  await AreaAssignment.create({ projectId: project._id, networkVersionId: v1._id, areaId: west._id, areaCode: 'W', driverId: ravi.user._id });
  await AreaCompletion.collection.insertOne({ projectId: project._id, areaCode: 'E', coverageCycleId: '', status: 'completed', completedAt: new Date() });
  const st = (await get(boss, `/versions/${project._id}/road-state`)).body;
  const s1 = st.versions.find((v) => v.versionId === String(v1._id));
  const covered = u32(s1.covered);
  const by = Array.from(Buffer.from(s1.coveredBy, 'base64'));
  assert(s1.key === k1c, 'the state names the file it describes');
  assert(covered.join() === '2,3', 'driven links are given as their place in the file — 200 and 9 — and a ledger row for a road no longer there is left out');
  assert(by.every((i) => st.drivers[i].name === 'ravi'), '…each with who drove it first');
  assert(st.heldCodes.join() === 'W' && st.signedOffCodes.join() === 'E', 'and which areas are out with a driver, which signed off');
  await LinkCoverage.create({ projectId: project._id, networkVersionId: v1._id, linkId: '10', lengthMeters: 100, firstTripId: trip, firstDriverId: ravi.user._id, firstAt: new Date(Date.now() + 1000) });
  const st2 = (await get(boss, `/versions/${project._id}/road-state`)).body;
  const covered2 = u32(st2.versions.find((v) => v.versionId === String(v1._id)).covered);
  assert(covered2.join() === '0,2,3', 'a newly driven road shows at once — the remembered answer is dropped when coverage changes');

  /* ── who may ── */
  assert((await get(stranger, `/versions/${project._id}/road-blobs`)).status === 403, 'a manager of another project may not list the files');
  assert((await get(stranger, `/road-blob/${v1._id}/${k1c}`)).status === 403, '…nor download one');
  assert((await get(stranger, `/versions/${project._id}/road-state`)).status === 403, '…nor read the state');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
