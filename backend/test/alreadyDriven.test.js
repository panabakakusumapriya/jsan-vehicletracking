// UKM split into Assigned / Outside, and "already driven before" on hover.
//
//   GET /api/trips/merged-summary   assignedUkm, outsideUkm, splitTrips per driver-day
//   GET /api/trips/:id/already-driven   services/alreadyDriven.js
//
// Assigned UKM is the customer's roads a trip drove first INSIDE its driver's areas; Outside UKM is
// the customer's roads it drove first anywhere else. Road somebody drove before counts in neither,
// and the hover says whose it was and when.
//
// Run: node test/alreadyDriven.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'already_driven_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, msg) => assert(a != null && Math.abs(a - b) <= 2, `${msg} (got ${a == null ? a : Math.round(a)}, want ${Math.round(b)})`);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('already_driven_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const { encodePolyline6 } = require('../src/services/valhalla');
  const { attributeTripLinks } = require('../src/services/linkCoverage');
  const { attributeTrip } = require('../src/services/globalUkm');
  const { lineLength } = require('../src/utils/geo');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const CoverageSegment = require('../src/models/CoverageSegment');
  await Promise.all([RoadLink.syncIndexes(), LinkCoverage.syncIndexes(), CoverageSegment.syncIndexes(), WorkArea.init()]);
  const app = createApp();

  // ── Westside (Ravi's area) and Eastside (nobody's) ──
  const line = (lon, a, b) => { const pts = []; for (let i = a; i <= b; i++) pts.push([lon, 50 + i * 0.001]); return pts; };
  const shape = (lon, a, b) => encodePolyline6(line(lon, a, b).map(([ln, lt]) => ({ lat: lt, lon: ln })));
  const box = (w, e) => [[[w, 49.999], [e, 49.999], [e, 50.005], [w, 50.005], [w, 49.999]]];
  const project = await Project.create({ name: 'HE Drive' });
  const version = await NetworkVersion.create({ projectId: project._id, label: 'v', status: 'active' });
  const mkArea = (code, w, e) => WorkArea.create({ projectId: project._id, networkVersionId: version._id, areaCode: code, name: code, geometry: { type: 'Polygon', coordinates: box(w, e) }, bbox: [w, 49.999, e, 50.005], targetMeters: 1000, targetLinks: 3 });
  const west = await mkArea('WEST', 7.99, 8.01);
  const east = await mkArea('EAST', 8.011, 8.03);
  const mkLink = (id, coords, area) => RoadLink.create({ projectId: project._id, networkVersionId: version._id, linkId: id, dirTravel: 'B', funcClass: 5, areaId: area._id, areaCode: area.areaCode, geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords) });
  const W1 = await mkLink('W1', line(8, 0, 2), west);
  const W2 = await mkLink('W2', line(8, 2, 4), west);
  const W3 = await mkLink('W3', line(8.003, 0, 2), west);
  const E1 = await mkLink('E1', line(8.02, 0, 4), east);

  const mkUser = async (name, role, extra = {}) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [project._id], ...extra });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'admin');
  const ravi = await mkUser('ravi', 'user');
  const sam = await mkUser('sam', 'user');
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: west._id, areaCode: 'WEST', driverId: ravi.user._id, assignedAt: new Date('2026-01-01') });

  let seq = 0;
  const mkTrip = (who, shapes, startedAt, endedAt) => Trip.create({
    clientTripId: `t${++seq}`, driverId: who.user._id, projectId: project._id, status: 'completed',
    startedAt, endedAt, cleanedRouteShapes: shapes, cleanedDistanceMeters: 1000, cleanedMatchedRatio: 1,
    mapMatchStatus: 'matched', distanceMeters: 1000,
  });
  const attribute = async (t) => { await attributeTrip(t._id); await attributeTripLinks(t._id); };

  // 3 Oct: Sam (no area) drives Ravi's main street W1+W2. 6 Oct: Ravi drives W1+W2 again, W3 in
  // his area, and E1 next door. 7 Oct: Ravi drives W3 once more.
  const samTrip = await mkTrip(sam, [shape(8, 0, 4)], new Date('2026-10-03T08:00:00Z'), new Date('2026-10-03T08:20:00Z'));
  const raviTrip = await mkTrip(ravi, [shape(8, 0, 4), shape(8.003, 0, 2), shape(8.02, 0, 4)], new Date('2026-10-06T08:00:00Z'), new Date('2026-10-06T09:00:00Z'));
  const raviAgain = await mkTrip(ravi, [shape(8.003, 0, 2)], new Date('2026-10-07T08:00:00Z'), new Date('2026-10-07T08:10:00Z'));
  for (const t of [samTrip, raviTrip, raviAgain]) await attribute(t);

  /* ── the split, per trip and per day ── */
  const r = await Trip.findById(raviTrip._id).lean();
  near(r.linkUkmMeters, W3.lengthMeters, 'Ravi 6 Oct: Assigned UKM is W3 — the one road in his area nobody had driven');
  near(r.linkUkmNetworkMeters - r.linkUkmMeters, E1.lengthMeters, '…Outside UKM is E1, new road outside his area');
  const days = (await boss.as(request(app).get('/api/trips/merged-summary'))).body.summaries;
  const day = (who, date) => days.find((d) => String(d.driverId) === String(who.user._id) && d.date === date);
  const d6 = day(ravi, '2026-10-06');
  near(d6.assignedUkm, W3.lengthMeters, 'the day row adds up Assigned UKM');
  near(d6.outsideUkm, E1.lengthMeters, 'and Outside UKM, separately');
  assert(d6.splitTrips === 1, 'and says how many of the day\'s trips are split');
  const d3 = day(sam, '2026-10-03');
  near(d3.assignedUkm, 0, 'Sam held no area: no Assigned UKM');
  near(d3.outsideUkm, W1.lengthMeters + W2.lengthMeters, '…all his new road is Outside UKM');

  /* ── already driven before ── */
  const ask = (t, who = boss) => who.as(request(app).get(`/api/trips/${t._id}/already-driven`));
  const res = await ask(raviTrip);
  assert(res.status === 200 && res.body.computed && res.body.basis === 'network', 'the hover is measured on the customer\'s network');
  near(res.body.ownInsideMeters, W3.lengthMeters, 'what this trip earned inside: W3');
  near(res.body.ownOutsideMeters, E1.lengthMeters, 'and outside: E1');
  near(res.body.repeatMeters, W1.lengthMeters + W2.lengthMeters, 'already driven before: W1+W2, not counted');
  assert(res.body.rows.length === 1 && res.body.rows[0].driverName === 'sam' && !res.body.rows[0].self, '…by Sam');
  assert(new Date(res.body.rows[0].at).toISOString().slice(0, 10) === '2026-10-03', '…on 3 Oct');
  near(res.body.rows[0].insideMeters, W1.lengthMeters + W2.lengthMeters, '…all of it inside Ravi\'s area');
  assert(String(res.body.rows[0].tripId) === String(samTrip._id), '…naming the trip that drove it first');

  const again = (await ask(raviAgain)).body;
  assert(again.rows.length === 1 && again.rows[0].self && again.rows[0].driverName === 'ravi', '7 Oct: W3 again is Ravi\'s own earlier road — marked as his own');
  near(again.ownInsideMeters + again.ownOutsideMeters, 0, '…and earns nothing');
  const first = (await ask(samTrip)).body;
  assert(first.rows.length === 0 && first.repeatMeters === 0, 'the first drive of a road has nothing "already driven"');

  /* ── who may ask ── */
  assert((await ask(raviTrip, sam)).status === 404, 'a driver cannot read another driver\'s trip');
  assert((await ask({ _id: new mongoose.Types.ObjectId() })).status === 404, 'an unknown trip is a 404');

  /* ── a project with no network: the fleet-wide road ledger answers ── */
  const other = await Project.create({ name: 'No network' });
  const bob = await mkUser('bob', 'user', { projectIds: [] });
  const bobTrip = (at) => Trip.create({ clientTripId: `b${++seq}`, driverId: bob.user._id, projectId: other._id, status: 'completed', startedAt: at, endedAt: new Date(at.getTime() + 600000), cleanedRouteShapes: [shape(9, 0, 4)], cleanedMatchedRatio: 1, mapMatchStatus: 'matched', distanceMeters: 450 });
  const b1 = await bobTrip(new Date('2026-10-01T08:00:00Z'));
  const b2 = await bobTrip(new Date('2026-10-02T08:00:00Z'));
  await attributeTrip(b1._id);
  await attributeTrip(b2._id);
  const g = (await ask(b2)).body;
  assert(g.computed && g.basis === 'global' && g.rows.length === 1 && g.rows[0].self, 'no network: answered from the fleet-wide ledger — his own drive of 1 Oct');
  assert(g.repeatMeters > 400 && g.ownOutsideMeters < 1, '…the whole route was already his');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
