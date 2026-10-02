// Splitting a work area that is too big for one driver into zones — and putting it back.
//
// The failure this exists for: Auckland's delivery (2026-10-01) is 58 places, and the city is ONE
// of them — 4,408 km of road under a single AREA_ID, 60% of the delivery. One area goes to one
// driver, so it could be given to nobody. A manager now picks such an area on the map, types the
// size a zone should be, and it is cut into zones of that size named after the suburbs inside.
//
// Rules under test:
//   - the plan: how many zones a length of road makes, and what happens to the leftover
//     (shared out among the zones, or kept as a smaller zone of its own);
//   - the zones: in range, each in one piece, named, tiling the area exactly, every road in the
//     zone whose polygon its midpoint falls in, the same answer every time;
//   - boundaries follow barriers: a river with two bridges is where a two-zone split cuts;
//   - in the database: links and coverage move to the zones, nothing is lost, a crashed run is
//     finished by the next one, and joining restores the area byte for byte;
//   - who may: managers, not drivers; not while a driver holds the area or it is signed off;
//   - the next delivery of the same ground keeps the zones, and an import never splits by itself.
//
// Run: node test/areaSplit.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'area_split_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

/* ------------------------------------------------------------------ a town to cut up */

const LON0 = 174.7;
const LAT0 = -36.95;
const D_LAT = 100 / 111194.92664455873; // 100 m of latitude
const D_LON = D_LAT / Math.cos((LAT0 * Math.PI) / 180);
const N = 40; // 40 x 40 streets, 100 m apart
/** Grid position -> [lon, lat]. Rows 20 and up sit `riverM` further north: the far bank. */
const at = (col, row, riverM = 0) => [LON0 + col * D_LON, LAT0 + (row + (row >= 20 ? riverM / 100 : 0)) * D_LAT];

/**
 * A grid town. With `riverM`, a river of that width runs between rows 19 and 20 and only the
 * streets at columns 5 and 30 cross it.
 */
function town({ riverM = 0 } = {}) {
  const { lineLength } = require('../src/utils/geo');
  const links = [];
  const push = (a, b) => {
    const coords = [at(a[0], a[1], riverM), at(b[0], b[1], riverM)];
    links.push({ linkId: `L${String(links.length).padStart(5, '0')}`, coords, meters: lineLength(coords), a, b });
  };
  for (let row = 0; row < N; row++) for (let col = 0; col < N - 1; col++) push([col, row], [col + 1, row]);
  for (let col = 0; col < N; col++) {
    for (let row = 0; row < N - 1; row++) {
      if (riverM && row === 19 && col !== 5 && col !== 30) continue;
      push([col, row], [col, row + 1]);
    }
  }
  const sw = at(-0.5, -0.5, riverM);
  const ne = at(N - 0.5, N - 0.5, riverM);
  const rect = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  // The town, and an island off its east side with no road on it.
  const iw = at(45, 10, riverM);
  const ie = at(48, 13, riverM);
  const geometry = {
    type: 'MultiPolygon',
    coordinates: [rect(sw[0], sw[1], ne[0], ne[1]), rect(iw[0], iw[1], ie[0], ie[1])],
  };
  const names = ['Ashby', 'Brookfield', 'Carrow', 'Denholm', 'Eastleigh', 'Farndon', 'Glenmoor', 'Harwick',
    'Ingleby', 'Jesmond', 'Kirkby', 'Langholm', 'Marton', 'Norbury', 'Oakham', 'Penrith'];
  const places = names.map((name, i) => {
    const [lon, lat] = at(5 + (i % 4) * 10, 5 + Math.floor(i / 4) * 10, riverM);
    return { name, kind: 'suburb', lon, lat };
  });
  const totalKm = links.reduce((s, l) => s + l.meters, 0) / 1000;
  return { links, geometry, places, totalKm, bbox: [sw[0], sw[1], ie[0], ne[1]], island: [(iw[0] + ie[0]) / 2, (iw[1] + ie[1]) / 2] };
}

(async () => {
  const { pointInPolygon, midpointOf } = require('../src/utils/geo');
  const areaSplit = require('../src/services/areaSplit');
  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  const zoneOfPoint = (zones, pt) => zones.map((z, i) => (polysOf(z.geometry).some((p) => pointInPolygon(pt, p)) ? i : -1)).filter((i) => i >= 0);

  /* ================================================================== the plan */
  const plan = (km, o = {}) => {
    const p = areaSplit.zonePlan(km, o);
    return `${p.count}: ${[...new Set(p.targetsKm.map((v) => v.toFixed(0)))].join('/')}${p.leftover ? ' +leftover' : ''}`;
  };
  assert(plan(4408) === '16: 276', '4,408 km at 250-300: 16 equal zones of ~276 km');
  assert(plan(620) === '2: 310', '620 km at 250-300: the leftover is shared out — two zones of 310');
  assert(plan(660) === '2: 330', '660 km at 250-300: two zones of 330, not three thin ones');
  assert(plan(660, { absorbRemainder: false }) === '3: 110/275 +leftover', '…or, leftover kept apart: 275, 275 and a 110 km zone');
  assert(plan(960, { minKm: 300, maxKm: 300 }) === '3: 320', 'one exact size (300): 960 km is three zones of 320');
  assert(plan(960, { minKm: 300, maxKm: 300, absorbRemainder: false }) === '4: 60/300 +leftover', '…or three of 300 and a 60 km leftover');
  assert(plan(342) === '1: 342' && !areaSplit.shouldSplit(342), '342 km at 250-300 is not enough for two zones');
  assert(areaSplit.shouldSplit(342, { absorbRemainder: false }), '…unless the leftover may stand alone (275 + 67)');
  assert(plan(200) === '1: 200' && plan(200, { absorbRemainder: false }) === '1: 200', '200 km stays whole either way');
  let threw = false;
  try { areaSplit.zonePlan(500, { minKm: 300, maxKm: 250 }); } catch (e) { threw = true; }
  assert(threw, 'a range the wrong way round is refused');

  /* ================================================================== the zones */
  const t = town();
  const area = { code: 'TOWN', name: 'Grid Town', geometry: t.geometry, priority: 2, props: { AREA_ID: 'TOWN' } };
  const opt = { minKm: 70, maxKm: 90 };
  const started = Date.now();
  const res = areaSplit.splitArea({ area, links: t.links, places: t.places, options: opt });
  console.log(`   ${t.links.length} links, ${t.totalKm.toFixed(1)} km -> ${res.zones.map((z) => (z.targetMeters / 1000).toFixed(1)).join(' / ')} km in ${Date.now() - started} ms`);
  assert(res.zones.length === 4, `${t.totalKm.toFixed(0)} km at 70-90 km makes 4 zones`);
  assert(res.zones.every((z) => z.targetMeters >= 70000 && z.targetMeters <= 90000), 'every zone is within 70-90 km');
  assert(Math.abs(res.zones.reduce((s, z) => s + z.targetMeters, 0) / 1000 - t.totalKm) < 1e-6 &&
    res.zones.reduce((s, z) => s + z.targetLinks, 0) === t.links.length, 'the zones hold every link and every metre, once');
  assert(res.zones.map((z) => z.code).join() === 'TOWN-01,TOWN-02,TOWN-03,TOWN-04', 'codes are the parent\'s with a number');
  assert(res.zones.every((z) => /^Grid Town \d\d – [A-Z]/.test(z.name)), `named after the places inside: "${res.zones[0].name}"`);
  const headline = res.zones.flatMap((z) => z.name.split(' – ')[1].split(', '));
  assert(new Set(headline).size === headline.length, 'no place headlines two zones');
  assert(res.zones.every((z) => z.parentName === 'Grid Town' && z.priority === 2 && z.props.splitFrom.code === 'TOWN' &&
    z.props.AREA_ID === 'TOWN' && z.props.zones === 4 && z.props.places.length > 0), 'zones carry parent name, priority, the parent\'s props and their places');
  assert(res.stats.midpointsOutside === 0 && t.links.every((l, i) => {
    const hits = zoneOfPoint(res.zones, midpointOf(l.coords));
    return hits.length === 1 && hits[0] === res.linkZone[i];
  }), 'every link\'s midpoint is in its own zone\'s polygon and in no other (the import\'s rule agrees with the plan)');

  // Tiling: a lattice of points over the parent — each in exactly one zone.
  let probes = 0;
  let exactlyOne = 0;
  for (let c = -0.4; c < N - 0.5; c += 0.37) {
    for (let r = -0.4; r < N - 0.5; r += 0.37) {
      probes++;
      if (zoneOfPoint(res.zones, at(c, r)).length === 1) exactlyOne++;
    }
  }
  assert(probes > 10000 && exactlyOne === probes, `${probes} points across the town: each is in exactly one zone (no gaps, no overlaps)`);
  const parentArea = areaSplit.geometryAreaSqm(t.geometry);
  assert(Math.abs(res.zones.reduce((s, z) => s + z.areaSqm, 0) - parentArea) / parentArea < 1e-4, 'the zones\' areas add up to the parent\'s');
  assert(zoneOfPoint(res.zones, at(-3, 5)).length === 0, 'a point outside the parent is in no zone');
  assert(zoneOfPoint(res.zones, t.island).length === 1 &&
    res.zones.filter((z) => polysOf(z.geometry).some((p) => p[0].length === 5 && pointInPolygon(t.island, p))).length === 1,
  'the roadless island goes whole to one zone, not cut between them');

  // Each zone is one connected piece of road.
  const nodeKey = (p) => `${p[0]}:${p[1]}`;
  const oneBlock = (zones, links, linkZone) => zones.every((_, z) => {
    const mine = links.map((l, i) => i).filter((i) => linkZone[i] === z);
    const byNode = new Map();
    for (const i of mine) for (const end of [links[i].a, links[i].b]) {
      const k = nodeKey(end);
      if (!byNode.has(k)) byNode.set(k, []);
      byNode.get(k).push(i);
    }
    const seen = new Set([mine[0]]);
    const queue = [mine[0]];
    for (let h = 0; h < queue.length; h++) for (const end of [links[queue[h]].a, links[queue[h]].b]) {
      for (const j of byNode.get(nodeKey(end))) if (!seen.has(j)) { seen.add(j); queue.push(j); }
    }
    return seen.size === mine.length;
  });
  assert(oneBlock(res.zones, t.links, res.linkZone), 'each zone\'s roads are one connected piece');

  const twice = areaSplit.splitArea({ area, links: t.links, places: t.places, options: opt });
  assert(JSON.stringify(twice.zones) === JSON.stringify(res.zones) && twice.linkZone.join() === res.linkZone.join(),
    'the same input gives the same zones, byte for byte');
  const shuffled = areaSplit.splitArea({ area, links: t.links, places: [...t.places].reverse(), options: opt });
  assert(JSON.stringify(shuffled.zones) === JSON.stringify(res.zones), '…whatever order the place names arrive in');

  const bare = areaSplit.splitArea({ area, links: t.links, places: [], options: opt });
  assert(bare.zones.length === 4 && bare.zones.every((z) => /^Grid Town \d\d$/.test(z.name) && z.targetMeters >= 70000 && z.targetMeters <= 90000),
    `with no place names the zones are numbered only ("${bare.zones[0].name}") and still in range`);

  const shared = areaSplit.splitArea({ area, links: t.links, places: t.places, options: { minKm: 100, maxKm: 100 } });
  assert(shared.zones.length === 3 && shared.zones.every((z) => z.targetMeters > 100000 && z.targetMeters < 110000),
    `one size of 100 km, leftover shared out: 3 zones of ${shared.zones.map((z) => (z.targetMeters / 1000).toFixed(0)).join('/')} km`);
  const apart = areaSplit.splitArea({ area, links: t.links, places: t.places, options: { minKm: 100, maxKm: 100, absorbRemainder: false } });
  const sizes = apart.zones.map((z) => z.targetMeters / 1000).sort((a, b) => a - b);
  assert(apart.zones.length === 4 && sizes[0] < 25 && sizes.slice(1).every((km) => km > 92 && km < 108),
    `…kept apart: three zones of ~100 km and a leftover of ${sizes[0].toFixed(0)} km`);

  /* ================================================================== barriers */
  const rv = town({ riverM: 600 });
  const two = areaSplit.splitArea({
    area: { ...area, geometry: rv.geometry }, links: rv.links, places: rv.places, options: { minKm: 140, maxKm: 165 },
  });
  const sides = two.zones.map((_, z) => new Set(rv.links.filter((l, i) => two.linkZone[i] === z).map((l) => (Math.min(l.a[1], l.b[1]) >= 20 ? 'north' : Math.max(l.a[1], l.b[1]) <= 19 ? 'south' : 'bridge'))));
  const crossing = rv.links.filter((l, i) => rv.links.some((m, j) => j > i && two.linkZone[i] !== two.linkZone[j] &&
    (nodeKey(l.a) === nodeKey(m.a) || nodeKey(l.a) === nodeKey(m.b) || nodeKey(l.b) === nodeKey(m.a) || nodeKey(l.b) === nodeKey(m.b)))).length;
  console.log(`   river town: zones of ${two.zones.map((z) => (z.targetMeters / 1000).toFixed(1)).join(' / ')} km; sides ${sides.map((s) => [...s].join('+')).join(' | ')}; ${crossing} links touch the other zone`);
  assert(two.zones.length === 2 && sides.every((s) => !(s.has('north') && s.has('south'))),
    'a river with two bridges: the two-zone split puts one zone on each bank');

  /* ================================================================== place names */
  const osm = require('../src/services/osmPlaces');
  const overpass = { elements: [
    { type: 'node', lon: 1, lat: 2, tags: { place: 'suburb', name: 'Ponsonby' } },
    { type: 'way', center: { lon: 3, lat: 4 }, tags: { place: 'quarter', name: 'Wynyard Quarter' } },
    { type: 'node', lon: 5, lat: 6, tags: { place: 'city', name: 'Auckland' } },
    { type: 'node', lon: 7, lat: 8, tags: { place: 'suburb', name: 'హైదరాబాద్', 'name:en': 'Banjara Hills' } },
    { type: 'node', lon: 9, lat: 9, tags: { place: 'suburb' } },
  ] };
  const parsed = osm.parsePlaces(overpass);
  assert(parsed.length === 3 && parsed.map((p) => p.name).join() === 'Banjara Hills,Ponsonby,Wynyard Quarter',
    'Overpass answer -> places: the city itself and nameless points dropped, ways by their centre, English name when the local one is not Latin');
  let calls = [];
  const ok = await osm.fetchPlaces([174, -37, 175, -36], {
    fetchImpl: async (url) => { calls.push(url); return calls.length === 1 ? { ok: false, status: 504 } : { ok: true, json: async () => overpass }; },
    endpoints: ['https://a.example/api', 'https://b.example/api'],
  });
  assert(ok.source === 'osm' && ok.places.length === 3 && calls.length === 2, 'a busy map server is skipped for the next one');
  const down = await osm.fetchPlaces([174, -37, 175, -36], { fetchImpl: async () => { throw new Error('ENOTFOUND'); }, endpoints: ['https://a.example/api'] });
  assert(down.places.length === 0 && /failed/.test(down.source), `no map server at all is not an error: no places, "${down.source}"`);
  const huge = await osm.fetchPlaces([100, -40, 160, 0], { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert(huge.places.length === 0, 'a box the size of a continent is not looked up');

  /* ================================================================== in the database */
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('area_split_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const AreaCompletion = require('../src/models/AreaCompletion');
  const AreaSplit = require('../src/models/AreaSplit');
  const workAreaSplit = require('../src/services/workAreaSplit');
  await Promise.all([WorkArea.init(), RoadLink.init(), LinkCoverage.init(), AreaAssignment.init(), AreaSplit.init()]);
  const app = createApp();

  // The endpoints look place names up themselves; in a test that must not reach the internet.
  let lookups = 0;
  osm.fetchPlaces = async () => { lookups++; return { places: t.places, source: 'osm' }; };

  const project = await Project.create({ name: 'Split Town' });
  const mkUser = async (name, role) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [project._id] });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const driver = await mkUser('driver', 'user');

  const version = await NetworkVersion.create({
    projectId: project._id, label: 'Town v1', status: 'active',
    counts: { areas: 2, links: t.links.length + 1, orphanLinks: 0 },
    targetMeters: t.totalKm * 1000 + 100, byPriority: [{ priority: 2, areas: 2, links: t.links.length + 1, meters: t.totalKm * 1000 + 100 }],
  });
  const parent = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'TOWN', name: 'Grid Town', priority: 2,
    geometry: t.geometry, bbox: t.bbox, areaSqm: parentArea, targetMeters: t.totalKm * 1000, targetLinks: t.links.length,
    props: { AREA_ID: 'TOWN' },
  });
  const far = at(100, 100);
  const village = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'VILLAGE', name: 'Far Village', priority: 2,
    geometry: { type: 'Polygon', coordinates: [[[far[0], far[1]], [far[0] + 0.01, far[1]], [far[0] + 0.01, far[1] + 0.01], [far[0], far[1] + 0.01], [far[0], far[1]]]] },
    bbox: [far[0], far[1], far[0] + 0.01, far[1] + 0.01], targetMeters: 100, targetLinks: 1,
  });
  await RoadLink.insertMany([
    ...t.links.map((l) => ({
      projectId: project._id, networkVersionId: version._id, linkId: l.linkId, areaId: parent._id, areaCode: 'TOWN', priority: 2,
      geometry: { type: 'LineString', coordinates: l.coords }, lengthMeters: l.meters,
    })),
    { projectId: project._id, networkVersionId: version._id, linkId: 'V1', areaId: village._id, areaCode: 'VILLAGE', priority: 2,
      geometry: { type: 'LineString', coordinates: [[far[0] + 0.001, far[1] + 0.001], [far[0] + 0.002, far[1] + 0.001]] }, lengthMeters: 100 },
  ]);
  const tripId = new mongoose.Types.ObjectId();
  const drove = t.links.filter((_, i) => i % 97 === 0);
  await LinkCoverage.insertMany(drove.map((l) => ({
    projectId: project._id, networkVersionId: version._id, linkId: l.linkId, lengthMeters: l.meters, areaId: parent._id,
    firstTripId: tripId, firstDriverId: driver.user._id, firstAt: new Date(),
  })));
  const original = await WorkArea.findById(parent._id).lean();
  const url = (areaId, what) => `/api/network/versions/${version._id}/areas/${areaId}/${what}`;

  // who may
  assert((await driver.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 70, maxKm: 90 })).status === 403, 'a driver may not split an area');
  assert((await boss.as(request(app).post(url(parent._id, 'split'))).send({})).status === 400, 'no size given is a 400, not a guess');
  const tooBig = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 250, maxKm: 300 });
  assert(tooBig.status === 409 && /not enough/.test(tooBig.body.error), `too little road for the size asked: ${tooBig.body.error}`);

  // preview
  const preview = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 70, maxKm: 90 });
  assert(preview.status === 200 && preview.body.applied === false && preview.body.zones.length === 4 && lookups === 1, 'preview: 4 zones, one place-name lookup');
  assert((await WorkArea.countDocuments({ networkVersionId: version._id })) === 2 &&
    (await RoadLink.countDocuments({ areaId: parent._id })) === t.links.length, 'preview changed no area and no link');

  // apply — the first attempt dies half way, the second finishes it
  const realUpdateMany = RoadLink.updateMany.bind(RoadLink);
  let n = 0;
  RoadLink.updateMany = (...args) => { n++; if (n === 3) throw new Error('boom'); return realUpdateMany(...args); };
  const crashed = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 70, maxKm: 90, apply: true });
  RoadLink.updateMany = realUpdateMany;
  const stranded = await RoadLink.countDocuments({ areaId: parent._id });
  assert(crashed.status === 500 && stranded > 0 && stranded < t.links.length, `a run that dies half way (${stranded} links still on the area) answers 500`);
  const applied = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 70, maxKm: 90, apply: true });
  assert(applied.status === 200 && applied.body.applied === true && lookups === 1, 'the next attempt finishes it, with the place names already on file');
  const zones = await WorkArea.find({ networkVersionId: version._id, 'props.splitFrom.code': 'TOWN' }).sort({ areaCode: 1 }).lean();
  assert(zones.length === 4 && !(await WorkArea.exists({ _id: parent._id })), 'four zones in place of the area');
  assert(JSON.stringify(zones.map((z) => [z.areaCode, z.name])) === JSON.stringify(preview.body.zones.map((z) => [z.code, z.name])) &&
    zones.every((z, i) => Math.abs(z.targetMeters / 1000 - preview.body.zones[i].km) < 1e-6), 'what was written is what was previewed');
  assert(zones.every((z) => z.outline && z.bbox.length === 4 && z.targetMeters >= 70000 && z.targetMeters <= 90000), 'zones have outlines and are in range');
  assert((await RoadLink.countDocuments({ areaId: parent._id })) === 0 &&
    (await RoadLink.countDocuments({ areaId: { $in: zones.map((z) => z._id) } })) === t.links.length, 'every link moved to a zone');
  for (const z of zones) {
    const [agg] = await RoadLink.aggregate([{ $match: { areaId: z._id } }, { $group: { _id: '$areaCode', m: { $sum: '$lengthMeters' }, c: { $sum: 1 } } }]);
    if (!(agg && agg._id === z.areaCode && Math.abs(agg.m - z.targetMeters) < 0.01 && agg.c === z.targetLinks)) assert(false, `${z.areaCode} totals`);
  }
  assert(true, 'each zone\'s links carry its code and add up to its stored total');
  const cov = await LinkCoverage.find({ networkVersionId: version._id }).lean();
  let covOk = cov.length === drove.length;
  for (const c of cov) {
    const l = await RoadLink.findOne({ networkVersionId: version._id, linkId: c.linkId }).lean();
    if (String(l.areaId) !== String(c.areaId)) covOk = false;
  }
  assert(covOk, `all ${drove.length} coverage rows followed their links to the zones — including the ones moved before the crash`);
  const v1 = await NetworkVersion.findById(version._id).lean();
  assert(v1.counts.areas === 5 && v1.byPriority[0].areas === 5 && v1.counts.orphanLinks === 0, 'the version counts 5 areas now');
  assert((await RoadLink.findOne({ linkId: 'V1' }).lean()).areaCode === 'VILLAGE', 'the other area was not touched');

  // the panel's view of it
  const list = await boss.as(request(app).get(`/api/network/versions/${version._id}/areas`));
  const row = list.body.areas.find((a) => a.areaCode === 'TOWN-01');
  assert(row && row.splitFrom && row.splitFrom.code === 'TOWN' && row.splitFrom.zones === 4 &&
    list.body.areas.find((a) => a.areaCode === 'VILLAGE').splitFrom === null, 'the areas list marks zones with where they came from');
  const place = zones[2].props.places[0].name;
  const found = await boss.as(request(app).get(`/api/network/versions/${version._id}/areas?q=${place}`));
  assert(found.body.areas.some((a) => a.areaCode === zones[2].areaCode), `searching "${place}" finds the zone that holds it`);
  const card = await boss.as(request(app).get(url(zones[0]._id, 'coverage')));
  assert(card.status === 200 && card.body.area.splitFrom.name === 'Grid Town', 'a zone\'s card says which area it is a zone of');

  // refusals
  const again = await boss.as(request(app).post(url(zones[0]._id, 'split'))).send({ minKm: 20, maxKm: 30, apply: true });
  assert(again.status === 409 && /already a zone/.test(again.body.error), 'a zone cannot be split further');
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: village._id, areaCode: 'VILLAGE', areaName: 'Far Village', driverId: driver.user._id, driverName: 'driver' });
  const held = await boss.as(request(app).post(url(village._id, 'split'))).send({ minKm: 5, maxKm: 6, apply: true });
  assert(held.status === 409 && /assigned to driver/.test(held.body.error), `an area in a driver's hands is refused: ${held.body.error}`);

  // joining back
  assert((await driver.as(request(app).post(url(zones[1]._id, 'join'))).send({})).status === 403, 'a driver may not join zones');
  const a1 = await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: zones[1]._id, areaCode: zones[1].areaCode, areaName: zones[1].name, driverId: driver.user._id, driverName: 'driver' });
  const blocked = await boss.as(request(app).post(url(zones[0]._id, 'join'))).send({});
  assert(blocked.status === 409 && /assigned/.test(blocked.body.error), 'joining is refused while any zone is assigned');
  await AreaAssignment.updateOne({ _id: a1._id }, { $set: { releasedAt: new Date() } });
  // Raw, as the app writes it (an upsert): the current cycle of a project that has never closed one is ''.
  await AreaCompletion.collection.insertOne({ projectId: project._id, coverageCycleId: '', areaCode: zones[3].areaCode, areaName: zones[3].name, status: 'completed' });
  await AreaCompletion.collection.insertOne({ projectId: project._id, coverageCycleId: 'last-year', areaCode: zones[0].areaCode, status: 'completed' });
  const signed = await boss.as(request(app).post(url(zones[0]._id, 'join'))).send({});
  assert(signed.status === 409 && /completed/.test(signed.body.error), '…or signed off');
  await AreaCompletion.deleteMany({ coverageCycleId: '' });
  // (the sign-off left over from a closed cycle does not stand in the way)
  const joined = await boss.as(request(app).post(url(zones[2]._id, 'join'))).send({});
  assert(joined.status === 200 && joined.body.joined && joined.body.removedZones === 4 && String(joined.body.area._id) === String(parent._id), 'joined, from one of its zones');
  const back = await WorkArea.findById(parent._id).lean();
  assert(JSON.stringify(back) === JSON.stringify(original), 'the area is back byte for byte — same _id, code, polygon and totals');
  assert((await WorkArea.countDocuments({ networkVersionId: version._id })) === 2 &&
    (await RoadLink.countDocuments({ areaId: parent._id, areaCode: 'TOWN' })) === t.links.length &&
    (await LinkCoverage.countDocuments({ areaId: parent._id })) === drove.length, 'its links and its coverage are back on it, and the zones are gone');
  assert((await NetworkVersion.findById(version._id).lean()).counts.areas === 2, 'the version counts 2 areas again');
  const notSplit = await boss.as(request(app).post(url(village._id, 'join'))).send({});
  assert(notSplit.status === 409 && /not been split/.test(notSplit.body.error), 'an area that was never split has nothing to join');

  // a different size the second time
  const resplit = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 100, maxKm: 100, absorbRemainder: false, apply: true });
  const kms = resplit.body.zones.map((z) => z.km).sort((x, y) => x - y);
  assert(resplit.status === 200 && kms.length === 4 && kms[0] < 25 && kms[1] > 92, `split again at 100 km with the leftover kept apart: ${kms.map((k) => k.toFixed(0)).join('/')} km`);
  await boss.as(request(app).post(url(resplit.body.zones[0]._id, 'join'))).send({});
  const final = await boss.as(request(app).post(url(parent._id, 'split'))).send({ minKm: 70, maxKm: 90, apply: true });
  assert(final.status === 200 && JSON.stringify(final.body.zones.map((z) => [z.code, z.name, z.links])) ===
    JSON.stringify(applied.body.zones.map((z) => [z.code, z.name, z.links])), 'back to 70-90 km gives the same four zones as the first time');

  /* ================================================================== the next delivery */
  const delivered = () => [
    { code: 'TOWN', name: 'Grid Town', priority: 2, geometry: t.geometry, bbox: t.bbox, props: {}, targetMeters: t.totalKm * 1000, targetLinks: t.links.length },
    { code: 'VILLAGE', name: 'Far Village', priority: 2, geometry: village.geometry, bbox: village.bbox, props: {}, targetMeters: 100, targetLinks: 1 },
  ];
  let asked = null;
  const linksOf = async (wanted) => { asked = [...wanted]; return new Map([[0, t.links.map((l) => ({ coords: l.coords, meters: l.meters }))]]); };
  const kept = await workAreaSplit.carrySplitsForward({ areas: delivered(), linksOf, projectId: project._id });
  assert(asked.join() === '0' && kept.splits.length === 1 && kept.splits[0].kept && kept.areas.length === 5 && kept.unplacedLinks === 0,
    'the same ground delivered again: Grid Town arrives whole and stays as its four zones');
  assert(kept.areas.slice(0, 4).every((a, i) => a.code === final.body.zones[i].code && a.name === final.body.zones[i].name &&
    a.targetLinks === final.body.zones[i].links && Math.abs(a.targetMeters / 1000 - final.body.zones[i].km) < 1e-6) && kept.areas[4].code === 'VILLAGE',
  'same codes, names and totals as the zones drivers are assigned from; the other area untouched');
  const elsewhere = await workAreaSplit.carrySplitsForward({ areas: delivered(), linksOf, projectId: new mongoose.Types.ObjectId() });
  assert(elsewhere.splits.length === 0 && elsewhere.areas.length === 2, 'another project gets the delivery as it comes — an import never splits by itself');
  const movedTown = t.links.map((l, i) => ({ coords: i % 10 === 0 ? [[l.coords[0][0] + 1, l.coords[0][1]], [l.coords[1][0] + 1, l.coords[1][1]]] : l.coords, meters: l.meters }));
  const changed = await workAreaSplit.carrySplitsForward({ areas: delivered(), linksOf: async () => new Map([[0, movedTown]]), projectId: project._id });
  assert(changed.splits.length === 1 && changed.splits[0].kept === false && changed.areas.length === 2 && changed.areas[0].code === 'TOWN',
    'a delivery whose roads no longer fit the old zones leaves the area whole, to be split afresh');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
