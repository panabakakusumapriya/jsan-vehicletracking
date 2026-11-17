// Overlaps between deliveries: measured, cut around, and checked — never guessed, never silent.
//
// Vietnam came as three deliveries on the same ground (P1 FC3 cities, P2 TPA sites, P3 FC1-2
// countrywide), and their areas must not be drawn over each other. Three failures pinned here:
//   - the overlap check sampled corners: once a zone was cut around a site, the hole's edge IS the
//     site's outline, so its corners lay exactly on the site's border and were called "inside" —
//     every cut zone was listed as still overlapping, with 0 m² actually shared;
//   - a zone that lay wholly inside another delivery could not be cut and was left whole, silently;
//   - an area that must stay whole (a fringe strip over two TPA sites) had no way to be cut at all.
//
// Run: node test/deliveryOverlaps.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'delivery_overlaps_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-12);

/** A square, west/south corner and side in degrees. */
const sq = (w, s, d) => ({ type: 'Polygon', coordinates: [[[w, s], [w + d, s], [w + d, s + d], [w, s + d], [w, s]]] });
const rect = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const pieces = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('delivery_overlaps_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  require('../src/services/importRunner').kickImportRunner = () => {};
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const was = require('../src/services/workAreaSplit');
  const { geometryAreaSqm } = require('../src/services/areaSplit');
  await WorkArea.init();
  const app = createApp();

  const project = await Project.create({ name: 'Vietnam (overlaps test)' });
  const boss = new User({ name: 'boss', email: 'boss@x.com', role: 'admin', projectIds: [project._id] });
  await boss.setPassword('pw123456'); await boss.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'boss@x.com', password: 'pw123456' })).body.token;
  const as = (q) => q.set('Authorization', `Bearer ${token}`);

  const mkLive = (label) => NetworkVersion.create({
    projectId: project._id, label, status: 'superseded', keepLive: true, targetMeters: 1,
    counts: { areas: 1, links: 0, orphanLinks: 0 }, byPriority: [{ priority: 0, areas: 1, links: 0, meters: 0 }],
  });
  const bboxOfGeom = (g) => {
    const pts = pieces(g).flatMap((p) => p[0]);
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  };
  const mkArea = (version, code, geometry, extra = {}) => WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: code, name: code, geometry,
    bbox: bboxOfGeom(geometry), areaSqm: geometryAreaSqm(geometry), ...extra,
  });
  /** East-west roads across [w, e] at the given latitudes, on `area`. */
  const mkRoads = async (version, area, w, e, lats) => {
    let i = 0;
    for (const lat of lats) {
      i += 1;
      // eslint-disable-next-line no-await-in-loop
      await RoadLink.create({
        projectId: project._id, networkVersionId: version._id, linkId: `${area.areaCode}-${i}`, dirTravel: 'B',
        areaId: area._id, areaCode: area.areaCode, lengthMeters: (e - w) * 104000,
        geometry: { type: 'LineString', coordinates: [[w, lat], [(w + e) / 2, lat], [e, lat]] },
      });
    }
  };

  console.log('\n-- measuring shared ground --');
  const g = was.sharedGround;
  assert(g(pieces(sq(105, 21, 0.02)), pieces(sq(105.02, 21, 0.02))).sqm === 0, 'two squares that share an edge share no ground');
  const site = sq(105.02, 21.02, 0.02);
  const siteSqm = geometryAreaSqm(site);
  const half = g(pieces(sq(105, 21.02, 0.03)), pieces(site)).sqm; // overlaps the site's west half
  assert(near(half, siteSqm / 2, 0.08), `half a site is measured as half its ground (${(half / 1e6).toFixed(3)} vs ${(siteSqm / 2e6).toFixed(3)} km²)`);
  // A plus sign: neither rectangle has a corner inside the other, but they cross — what sampling missed.
  const across = g(pieces(rect(105, 21.04, 105.1, 21.06)), pieces(rect(105.04, 21, 105.06, 21.1))).sqm;
  assert(across > 0 && near(across, geometryAreaSqm(sq(105.04, 21.04, 0.02)), 0.1), 'outlines that cross with no corner inside each other still overlap');
  const holed = { type: 'Polygon', coordinates: [sq(105, 21, 0.06).coordinates[0], [...site.coordinates[0]].reverse()] };
  assert(g(pieces(holed), pieces(site)).sqm === 0, 'a zone already cut around a site shares no ground with it — the hole edge only touches');

  console.log('\n-- which deliveries an area overlaps --');
  const P2 = await mkLive('P2 - TPA sites');
  const siteArea = await mkArea(P2, 'DCR-1', site);
  const P3 = await mkLive('P3 - countrywide');
  const cutZone = await mkArea(P3, 'P3-CUT', holed);
  assert((await was.overlappingDeliveries({ versionId: P3._id, parent: cutZone.toObject() })).length === 0,
    'the cut zone is not reported as overlapping the site');
  const P1 = await mkLive('P1 - fringe');
  const strip = await mkArea(P1, 'P1X', rect(105, 21.025, 105.06, 21.035)); // runs across the site
  const rows = await was.overlappingDeliveries({ versionId: P1._id, parent: strip.toObject() });
  const p2row = rows.find((r) => String(r.versionId) === String(P2._id));
  assert(p2row && p2row.areas.length === 1 && p2row.areas[0].areaCode === 'DCR-1', 'a strip drawn across the site is reported, with the site named');
  const crossSqm = geometryAreaSqm(rect(105.02, 21.025, 105.04, 21.035));
  assert(near(p2row.sqm, crossSqm, 0.1), `and the ground it shares is measured (${(p2row.sqm / 1e6).toFixed(3)} vs ${(crossSqm / 1e6).toFixed(3)} km²)`);
  assert(near(p2row.areas[0].share, crossSqm / siteSqm, 0.1), 'with the share of the site it covers');

  console.log('\n-- the dialog\'s check, over HTTP --');
  const api = await as(request(app).get(`/api/network/versions/${P1._id}/areas/${strip._id}/overlaps`));
  const apiP2 = (api.body.deliveries || []).find((d) => d.versionId === String(P2._id));
  assert(api.status === 200 && apiP2 && apiP2.sqKm > 0 && apiP2.list[0].name === 'DCR-1',
    'GET …/overlaps lists the delivery, the area and the km² shared');
  const apiClean = await as(request(app).get(`/api/network/versions/${P3._id}/areas/${cutZone._id}/overlaps`));
  assert(apiClean.status === 200 && !apiClean.body.deliveries.some((d) => d.versionId === String(P2._id)),
    'and the site is not listed for the zone already cut around it');

  console.log('\n-- cut around, keeping the area whole --');
  await mkRoads(P1, strip, 105, 105.06, [21.028, 21.032]); // both run through the site
  const noTick = await as(request(app).post(`/api/network/versions/${P1._id}/areas/${strip._id}/cut-around`)).send({ cutAround: [] });
  assert(noTick.status === 400, 'nothing ticked: refused');
  const plan = await as(request(app).post(`/api/network/versions/${P1._id}/areas/${strip._id}/cut-around`)).send({ cutAround: [String(P2._id)] });
  assert(plan.status === 200 && !plan.body.applied && near(plan.body.cutSqKm * 1e6, crossSqm, 0.02), 'the preview says how much ground comes out, and writes nothing');
  assert(plan.body.remaining.length === 0, 'and checks that nothing would be left overlapping');
  assert(plan.body.excluded[0].links === 2, 'its two roads through the site stay with it');
  const unchanged = await WorkArea.findById(strip._id).lean();
  assert(geometryAreaSqm(unchanged.geometry) > geometryAreaSqm(rect(105, 21.025, 105.06, 21.035)) - 1, 'preview: the outline is untouched');
  const done = await as(request(app).post(`/api/network/versions/${P1._id}/areas/${strip._id}/cut-around`)).send({ cutAround: [String(P2._id)], apply: true });
  assert(done.status === 200 && done.body.applied, 'applied');
  const after = await WorkArea.findById(strip._id).lean();
  assert(after.areaCode === 'P1X' && String(after._id) === String(strip._id), 'it is the same area — same id, same code');
  assert(after.geometry.type === 'MultiPolygon' && after.outline && after.bbox.length === 4, 'its outline (and the simplified map outline) now has the site taken out — two pieces');
  assert((after.props.cutAround || []).some((c) => String(c.versionId) === String(P2._id)), 'what it was cut around is recorded on it');
  assert((await RoadLink.countDocuments({ areaId: strip._id })) === 2, 'every road still belongs to it');
  assert(!(await was.overlappingDeliveries({ versionId: P1._id, parent: after })).some((r) => String(r.versionId) === String(P2._id)), 'and it no longer overlaps the site');
  const again = await as(request(app).post(`/api/network/versions/${P1._id}/areas/${strip._id}/cut-around`)).send({ cutAround: [String(P2._id)] });
  assert(again.status === 409, 'cutting again: refused, there is nothing left to cut around');

  const inside = await mkArea(P1, 'INSIDE', sq(105.025, 21.025, 0.005)); // wholly inside the site
  const whole = await as(request(app).post(`/api/network/versions/${P1._id}/areas/${inside._id}/cut-around`)).send({ cutAround: [String(P2._id)] });
  assert(whole.status === 409 && /entirely inside/.test(whole.body.error), 'an area wholly inside the site is refused, and says why — not cut to nothing');

  console.log('\n-- after a cut, what still overlaps is listed --');
  const left = was.remainingOverlaps(
    [{ code: 'Z1', name: 'Zone 1', geometry: holed }, { code: 'Z2', name: 'Zone 2', geometry: sq(105.025, 21.025, 0.005) }],
    [{ label: 'P2 - TPA sites', pieces: pieces(site) }]
  );
  assert(left.length === 1 && left[0].code === 'Z2' && left[0].with[0] === 'P2 - TPA sites', 'a zone lying inside the site is named; the cut one is not');

  console.log('\n-- splitting, cut around a site --');
  const P3b = await mkLive('P3 - to split');
  const big = await mkArea(P3b, 'BIG', sq(106, 21, 0.06));
  await mkArea(P2, 'DCR-2', sq(106.02, 21.02, 0.02));
  const lats = Array.from({ length: 12 }, (_, i) => 21.0025 + i * 0.005);
  await mkRoads(P3b, big, 106, 106.06, lats);
  const split = await was.splitCommittedArea({
    versionId: P3b._id, areaId: big._id, options: { minKm: 10, maxKm: 20 }, places: [], cutAround: [String(P2._id)],
  });
  assert(split.zones.length >= 2 && split.zonesCutAround >= 1, `the preview cuts the zones around the site (${split.zonesCutAround} of ${split.zones.length})`);
  assert(Array.isArray(split.remaining) && split.remaining.length === 0, 'and checks that no zone is left on it');
  const ov = split.overlaps.find((o) => o.versionId === String(P2._id));
  assert(ov && ov.cutAround && ov.sqKm > 0 && ov.list.some((a) => a.code === 'DCR-2'), 'the overlap it cut around is reported with its km²');
  const plain = await was.splitCommittedArea({ versionId: P3b._id, areaId: big._id, options: { minKm: 10, maxKm: 20 }, places: [] });
  assert(plain.zonesCutAround === 0 && plain.remaining.length === 0 && plain.overlaps.some((o) => o.versionId === String(P2._id) && !o.cutAround),
    'not ticked: nothing is cut, and the overlap is still listed so the panel can warn');

  console.log(`\n🎉 DELIVERY OVERLAPS — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
