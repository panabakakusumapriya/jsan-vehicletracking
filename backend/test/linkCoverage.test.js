// Assigned-network coverage: services/linkCoverage.js + models/LinkCoverage.js.
//
// The rules under test: a customer road link is claimed once per network by whoever reached it
// first; a driver holding polygons is measured on the links inside them (assigned-route UKM), a
// driver holding none on global UKM; and driving is split into inside / outside the assigned
// polygon, with a buffer on both the link match and the polygon boundary.
//
// Run: npm run test:link-coverage
process.env.JWT_SECRET = process.env.JWT_SECRET || 'link_coverage_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a})`);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('link_coverage_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { attributeTrip } = require('../src/services/globalUkm');
  const { attributeTripLinks, rebuildNetworkCoverage } = require('../src/services/linkCoverage');
  const { getDriverRoads } = require('../src/services/driverRoads');
  const { clearScopeCache } = require('../src/services/coverageScope');
  const { lineLength } = require('../src/utils/geo');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const CoverageSegment = require('../src/models/CoverageSegment');
  // The 2dsphere index must exist before $geoIntersects is used; ensure it rather than hope.
  await RoadLink.syncIndexes();
  await LinkCoverage.syncIndexes();

  // ── A tiny customer network ──
  // A north–south street along lon 8 from lat 50.000 to 50.004 in two links (L1, L2), a third link
  // L3 further north (50.006–50.008) OUTSIDE the polygon, and a one-way link L4 running north on a
  // parallel street 215 m east. One step of 0.001° latitude is ~111.2 m.
  const STEP_M = 111.195;
  const steps = (n) => n * STEP_M;
  const line = (lon, fromStep, toStep) => {
    const pts = [];
    const dir = toStep >= fromStep ? 1 : -1;
    for (let i = fromStep; dir > 0 ? i <= toStep : i >= toStep; i += dir) pts.push([lon, 50 + i * 0.001]);
    return pts;
  };
  const shape = (lon, fromStep, toStep) =>
    encodePolyline6(line(lon, fromStep, toStep).map(([ln, lt]) => ({ lat: lt, lon: ln })));
  const shapeOf = (pts) => encodePolyline6(pts.map(([ln, lt]) => ({ lat: lt, lon: ln })));

  // Polygon covering lat 49.999–50.005 around lon 8 — so L1 and L2 are inside, L3 is outside.
  const POLY = [[[7.99, 49.999], [8.01, 49.999], [8.01, 50.005], [7.99, 50.005], [7.99, 49.999]]];

  const T0 = new Date('2026-03-01T06:00:00Z').getTime();
  const at = (minutes) => new Date(T0 + minutes * 60_000);

  let seq = 0;
  const makeDriver = async (name, projectIds) => {
    const u = new User({ name, email: `d${++seq}@x.com`, role: 'user', projectIds });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };
  const makeTrip = async (driver, project, shapes, startMin, endMin, extra = {}) =>
    Trip.create({
      clientTripId: `t${++seq}`,
      driverId: driver._id,
      projectId: project._id,
      status: 'completed',
      startedAt: at(startMin),
      endedAt: at(endMin),
      cleanedRouteShapes: shapes,
      cleanedDistanceMeters: 0,
      cleanedMatchedRatio: 1,
      mapMatchStatus: 'matched',
      distanceMeters: 0,
      ...extra,
    });
  const reload = (t) => Trip.findById(t._id).lean();

  let project;
  let version;
  let area;
  let links;
  const L = {};
  const reset = async () => {
    await Promise.all([
      Trip.deleteMany({}), LinkCoverage.deleteMany({}), CoverageSegment.deleteMany({}),
      Project.deleteMany({}), NetworkVersion.deleteMany({}), WorkArea.deleteMany({}),
      RoadLink.deleteMany({}), AreaAssignment.deleteMany({}), User.deleteMany({}),
    ]);
    clearScopeCache();
    project = await Project.create({ name: 'HE Drive' });
    version = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'active' });
    area = await WorkArea.create({
      projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-1', name: 'Wallan',
      geometry: { type: 'Polygon', coordinates: POLY }, bbox: [7.99, 49.999, 8.01, 50.005],
    });
    const mk = async (linkId, coords, dirTravel, areaId) =>
      RoadLink.create({
        projectId: project._id, networkVersionId: version._id, linkId, dirTravel, areaId,
        areaCode: areaId ? 'SA2-1' : null,
        geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords),
      });
    L.L1 = await mk('L1', line(8, 0, 2), 'B', area._id);
    L.L2 = await mk('L2', line(8, 2, 4), 'B', area._id);
    L.L3 = await mk('L3', line(8, 6, 8), 'B', null);
    L.L4 = await mk('L4', line(8.003, 0, 2), 'F', area._id);
    links = L;
  };
  const assign = (driver, assignedAt = at(-60)) =>
    AreaAssignment.create({
      projectId: project._id, networkVersionId: version._id, areaId: area._id, driverId: driver._id,
      areaCode: 'SA2-1', assignedAt,
    });
  const owner = async (linkId) => (await LinkCoverage.findOne({ linkId }).lean())?.firstTripId;

  // ── Test A: assigned driver covers their polygon ──
  console.log('\n── Test A: assigned driver drives the whole polygon ──');
  {
    await reset();
    const d = await makeDriver('A', [project._id]);
    await assign(d);
    const t = await makeTrip(d, project, [shape(8, 0, 4)], 0, 20);
    await attributeTrip(t._id);
    await attributeTripLinks(t._id);
    const r = await reload(t);
    assert(r.linkCoverageStatus === 'computed', 'status is computed');
    assert(r.ukmBasis === 'assigned', 'a driver holding a polygon is measured on assigned roads');
    assert(String(await owner('L1')) === String(t._id) && String(await owner('L2')) === String(t._id), 'L1 and L2 are claimed by the trip');
    assert((await owner('L3')) == null, 'L3 (not driven) is not claimed');
    assert((await owner('L4')) == null, 'L4 (parallel street 215 m away) is not claimed by proximity');
    near(r.linkUkmMeters, links.L1.lengthMeters + links.L2.lengthMeters, 1, 'assigned-route UKM is the length of L1+L2');
    near(r.effectiveUkmMeters, r.linkUkmMeters, 0.01, 'effective UKM equals the assigned figure');
    near(r.inAreaMeters, steps(4), 1, 'all 4 steps are inside the polygon');
    near(r.outAreaMeters, 0, 0.01, 'nothing outside');
    assert(r.linkUkmShapes.length === 2, 'the two covered links ship as shapes for the map');
    const row = await LinkCoverage.findOne({ linkId: 'L1' }).lean();
    near(row.firstFraction, 1, 0.05, 'L1 was covered end to end');
    assert(String(row.areaId) === String(area._id) && row.lengthMeters > 0, 'ledger row carries the denormalised area and length');

    const roads = await getDriverRoads({ driverId: d._id, projectIds: [project._id], areaId: area._id });
    const covered = new Set(roads.links.filter((l) => l[2] === 1).map((l) => l[0]));
    assert(covered.has('L1') && covered.has('L2') && !covered.has('L4'), 'the driver map now paints L1 and L2 blue and L4 red');
  }

  // ── Test B: a second driver over the same links later ──
  console.log('\n── Test B: second driver, same links, later ──');
  {
    await reset();
    const d1 = await makeDriver('B1', [project._id]);
    const d2 = await makeDriver('B2', [project._id]);
    await assign(d1);
    await assign(d2);
    const t1 = await makeTrip(d1, project, [shape(8, 0, 4)], 0, 20);
    const t2 = await makeTrip(d2, project, [shape(8, 4, 0)], 120, 140); // opposite direction
    await attributeTripLinks(t1._id);
    await attributeTripLinks(t2._id);
    assert(String(await owner('L1')) === String(t1._id), 'first driver keeps L1');
    near((await reload(t2)).linkUkmMeters, 0, 0.01, 'second driver earns 0 assigned UKM');
    assert((await reload(t2)).linkCoveredCount === 2, 'but the trip is recorded as having driven both links');
    const row = await LinkCoverage.findOne({ linkId: 'L1' }).lean();
    assert(row.passes === 2 && String(row.lastTripId) === String(t2._id), 'the repeat is counted as a pass');
    await attributeTripLinks(t2._id);
    assert((await LinkCoverage.findOne({ linkId: 'L1' }).lean()).passes === 2, 're-running attribution does not invent a third pass');
  }

  // ── Test C: driving out of the polygon ──
  console.log('\n── Test C: route leaves the polygon ──');
  {
    await reset();
    const d = await makeDriver('C', [project._id]);
    await assign(d);
    const t = await makeTrip(d, project, [shape(8, 0, 8)], 0, 40);
    await attributeTripLinks(t._id);
    const r = await reload(t);
    // Step midpoints at 50.0005 … 50.0075; the boundary is at 50.005 with a 20 m buffer, so the
    // five steps up to 50.0045 are inside and the three from 50.0055 on are outside.
    near(r.inAreaMeters, steps(5), 1, 'five steps inside the polygon');
    near(r.outAreaMeters, steps(3), 1, 'three steps outside it');
    assert(r.outAreaShapes.length === 1, 'the outside stretch ships as one shape');
    near(r.linkUkmMeters, links.L1.lengthMeters + links.L2.lengthMeters, 1, 'assigned UKM counts only the links inside the patch');
    near(r.linkUkmNetworkMeters, links.L1.lengthMeters + links.L2.lengthMeters + links.L3.lengthMeters, 1, 'network UKM also counts L3 outside it');
    assert(String(await owner('L3')) === String(t._id), 'L3 is still claimed for the project');
  }

  // ── Test D: a graze does not claim a link ──
  console.log('\n── Test D: fraction threshold ──');
  {
    await reset();
    const d = await makeDriver('D', [project._id]);
    await assign(d);
    // 44 m north along L1 (which is 222 m long) then away east.
    const t = await makeTrip(d, project, [shapeOf([[8, 50], [8, 50.0004], [8.001, 50.0004], [8.002, 50.0004]])], 0, 10);
    await attributeTripLinks(t._id);
    assert((await owner('L1')) == null, '20% of a link is not coverage');
    near((await reload(t)).linkUkmMeters, 0, 0.01, 'and earns 0');
  }

  // ── Test E: one-way heading gate ──
  console.log('\n── Test E: one-way link, wrong direction ──');
  {
    await reset();
    const d = await makeDriver('E', [project._id]);
    await assign(d);
    const south = await makeTrip(d, project, [shape(8.003, 2, 0)], 0, 10);
    await attributeTripLinks(south._id);
    assert((await owner('L4')) == null, 'driving a northbound-only link southbound does not cover it');
    const north = await makeTrip(d, project, [shape(8.003, 0, 2)], 60, 70);
    await attributeTripLinks(north._id);
    assert(String(await owner('L4')) === String(north._id), 'driving it northbound does');
  }

  // ── Test F: no polygon → global basis ──
  console.log('\n── Test F: unassigned driver falls back to global UKM ──');
  {
    await reset();
    const d = await makeDriver('F', [project._id]);
    const t = await makeTrip(d, project, [shape(8, 0, 4)], 0, 20);
    await attributeTrip(t._id);
    await attributeTripLinks(t._id);
    const r = await reload(t);
    assert(r.ukmBasis === 'global', 'basis is global');
    assert(r.inAreaMeters == null && r.outAreaMeters == null, 'no polygon: in/out are null, not zero');
    assert(r.linkUkmMeters == null, 'assigned UKM is null, not zero');
    near(r.linkUkmNetworkMeters, links.L1.lengthMeters + links.L2.lengthMeters, 1, 'the links are still claimed for the project');
    near(r.effectiveUkmMeters, r.globalUniqueMeters, 0.01, 'effective UKM is the global figure');
    near(r.globalUniqueMeters, steps(4), 1, 'which is the whole new route');
  }

  // ── Test G: an earlier-observed late upload takes the link back ──
  console.log('\n── Test G: takeover by observation time ──');
  {
    await reset();
    const d1 = await makeDriver('G1', [project._id]);
    const d2 = await makeDriver('G2', [project._id]);
    await assign(d1);
    await assign(d2);
    const late = await makeTrip(d1, project, [shape(8, 0, 4)], 120, 140);
    await attributeTripLinks(late._id);
    near((await reload(late)).linkUkmMeters, links.L1.lengthMeters + links.L2.lengthMeters, 1, 'provisional owner earns both links');
    const early = await makeTrip(d2, project, [shape(8, 0, 4)], 0, 20); // driven earlier, uploaded later
    await attributeTripLinks(early._id);
    assert(String(await owner('L1')) === String(early._id), 'the earlier drive owns L1');
    near((await reload(early)).linkUkmMeters, links.L1.lengthMeters + links.L2.lengthMeters, 1, 'and earns both links');
    near((await reload(late)).linkUkmMeters, 0, 0.01, 'the displaced trip is recomputed to 0');
  }

  // ── Test H: re-match releases links no longer covered ──
  console.log('\n── Test H: release on re-attribution ──');
  {
    await reset();
    const d = await makeDriver('H', [project._id]);
    await assign(d);
    const t = await makeTrip(d, project, [shape(8, 0, 4)], 0, 20);
    await attributeTripLinks(t._id);
    assert((await owner('L2')) != null, 'L2 claimed');
    await Trip.updateOne({ _id: t._id }, { $set: { cleanedRouteShapes: [shape(8, 0, 2)], mapMatchedAt: new Date() } });
    await attributeTripLinks(t._id);
    assert((await owner('L2')) == null, 'L2 released after the route shrank to L1 only');
    near((await reload(t)).linkUkmMeters, links.L1.lengthMeters, 1, 'UKM now reflects only L1');
  }

  // ── Test I: rebuild reproduces the incremental result ──
  console.log('\n── Test I: rebuild == incremental ──');
  {
    await reset();
    const d1 = await makeDriver('I1', [project._id]);
    const d2 = await makeDriver('I2', [project._id]);
    await assign(d1);
    await assign(d2);
    const a = await makeTrip(d1, project, [shape(8, 0, 4)], 0, 20);
    const b = await makeTrip(d2, project, [shape(8, 0, 8)], 60, 100);
    await attributeTripLinks(b._id); // deliberately out of order
    await attributeTripLinks(a._id);
    const snapshot = async () => {
      const rows = await LinkCoverage.find({}).select('linkId firstTripId').sort({ linkId: 1 }).lean();
      const trips = await Trip.find({}).select('linkUkmMeters inAreaMeters outAreaMeters').sort({ _id: 1 }).lean();
      return JSON.stringify({ rows: rows.map((r) => [r.linkId, String(r.firstTripId)]), trips });
    };
    const before = await snapshot();
    const summary = await rebuildNetworkCoverage(version._id);
    assert(summary.attributed === 2 && summary.coveredLinks === 3, 'rebuild attributed both trips over three links');
    assert((await snapshot()) === before, 'rebuild produces the same owners and figures as the incremental path');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 ASSIGNED-NETWORK COVERAGE VERIFIED — ${passed} assertions passed`);
})().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  try { await require('mongoose').disconnect(); } catch { /* ignore */ }
});
