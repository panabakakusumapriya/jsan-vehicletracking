// Which columns an import uses, chosen without asking: services/networkImport.js.
//
// Every New Zealand upload stopped at "No area code column identified — choose one below": HERE's
// Admin4 work-area layer keys a place by AREA_ID and names it in POLYGON_NM, and the guess only knew
// the Australian ABS names (SA2_21CODE, SA2_21NAME). Three fixes, each tested here:
//   - the guess knows HERE Admin columns, and still prefers SA2 where both could match;
//   - a project remembers the columns its last successful import used, where the new file has them;
//   - a HERE Admin layer joins the pieces of a place (one AREA_ID, many POLYGON_IDs) by default,
//     until the operator says otherwise — and a merged ABS file still does not.
//
// Run: node test/importMapping.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'import_mapping_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('import_mapping_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const ni = require('../src/services/networkImport');
  const ImportJob = require('../src/models/ImportJob');

  const fields = (...names) => names.map((name) => ({ name }));
  // The columns of the real files, as the preflight reported them.
  const ADMIN4 = fields('POLYGON_ID', 'AREA_ID', 'NM_AREA_ID', 'POLYGON_NM', 'NM_LANGCD', 'POLY_NM_TR', 'TRANS_TYPE', 'FEAT_TYPE', 'DETAIL_CTY', 'FEAT_COD', 'COVERIND', 'CLAIMED_BY', 'CONTROL_BY');
  const ABS = fields('SA2_21PPID', 'SA2_21PID', 'SA2_21CODE', 'SA2_21NAME', 'SA3_21CODE', 'SA3_21NAME', 'SA4_21CODE', 'SA4_21NAME', 'AREA_SQM', 'Priority');
  const NAV = fields('LINK_ID', 'ST_NAME', 'FUNC_CLASS', 'DIR_TRAVEL', 'AR_AUTO', 'PAVED', 'LENGTH');

  /* ── the guess ── */
  const here = ni.sniffBoundaryMapping(ADMIN4);
  assert(here.areaCode === 'AREA_ID', 'HERE Admin4: the area is AREA_ID — not POLYGON_ID, which is one piece of it');
  assert(here.areaName === 'POLYGON_NM', '…and its name is POLYGON_NM');
  const abs = ni.sniffBoundaryMapping(ABS);
  assert(abs.areaCode === 'SA2_21CODE' && abs.areaName === 'SA2_21NAME' && abs.areaParent === 'SA3_21NAME' && abs.priority === 'Priority',
    'the Australian ABS file is still read exactly as before');
  assert(ni.sniffNetworkMapping(NAV).linkId === 'LINK_ID', 'the road layer is unchanged');

  /* ── remembered from the project's last import ── */
  const projectId = new mongoose.Types.ObjectId();
  const requestedBy = new mongoose.Types.ObjectId();
  const job = await ImportJob.create({ projectId, requestedBy, label: 'new' });
  assert(Object.keys(await ni.rememberedMapping(job, ADMIN4, NAV)).length === 0, 'a project with no earlier import remembers nothing');
  await ImportJob.create({
    projectId, requestedBy, label: 'older', status: 'ready', networkVersionId: new mongoose.Types.ObjectId(), createdAt: new Date('2026-09-01'),
    mapping: { areaCode: 'OLD_CODE', areaName: 'OLD_NAME', linkId: 'OLD_LINK' },
  });
  await ImportJob.create({
    projectId, requestedBy, label: 'last', status: 'ready', networkVersionId: new mongoose.Types.ObjectId(), createdAt: new Date('2026-10-01'),
    mapping: { areaCode: 'SUBURB_NO', areaName: 'SUBURB', priority: 'TIER', linkId: 'LINK_ID', linkName: 'ROAD' },
  });
  await ImportJob.create({ projectId, requestedBy, label: 'failed', status: 'failed', createdAt: new Date('2026-10-02'), mapping: { areaCode: 'WRONG' } });
  const custom = fields('SUBURB_NO', 'SUBURB', 'TIER', 'CODE');
  const memory = await ni.rememberedMapping(job, custom, NAV);
  assert(memory.areaCode === 'SUBURB_NO' && memory.areaName === 'SUBURB' && memory.priority === 'TIER',
    'the columns the last successful import used come back — a failed or older one is not the reference');
  assert(memory.linkId === 'LINK_ID' && !memory.linkName, '…but only where this file has that column (no ROAD column here, so no road name)');
  assert(ni.sniffBoundaryMapping(custom).areaCode === 'CODE', '(without the memory, the guess would have taken the wrong column)');
  const other = await ImportJob.create({ projectId: new mongoose.Types.ObjectId(), requestedBy, label: 'x' });
  assert(Object.keys(await ni.rememberedMapping(other, custom, NAV)).length === 0, 'another project\'s imports are not remembered');
  assert(Object.keys(await ni.rememberedMapping(job, ADMIN4, null)).length === 0, 'a file in a different format inherits nothing it does not have');

  /* ── joining the pieces of a place ── */
  const fresh = { joinAreaParts: false, joinAreaPartsChosenAt: null };
  assert(ni.joinPartsFor(fresh, ADMIN4, here) === true, 'a HERE Admin layer keyed by AREA_ID joins its pieces without being asked');
  assert(ni.joinPartsFor(fresh, ADMIN4, { areaCode: 'POLYGON_ID' }) === false, '…not when the operator keyed it by POLYGON_ID instead');
  assert(ni.joinPartsFor(fresh, ABS, abs) === false, 'a merged ABS file does not: there a repeated code is a copy');
  assert(ni.joinPartsFor({ joinAreaParts: false, joinAreaPartsChosenAt: new Date() }, ADMIN4, here) === false, 'an operator who unticked it is obeyed');
  assert(ni.joinPartsFor({ joinAreaParts: true, joinAreaPartsChosenAt: null }, ABS, abs) === true, 'and one who ticked it, whatever the file');

  /* ── files with no code / id column (the 2026-11 VIC delivery) ── */
  // Suburbs: POLYGON_ID + POLYGON_NM only. Roads: no id column at all.
  const VIC_AREAS = fields('POLYGON_ID', 'POLYGON_NM');
  const VIC_ROADS = fields('ST_NAME', 'FUNC_CLASS', 'DIR_TRAVEL', 'AR_AUTO', 'PAVED', 'PRIVATE', 'FERRY_TYPE', 'PUB_ACCESS');
  const vicAreas = ni.sniffBoundaryMapping(VIC_AREAS);
  assert(vicAreas.areaCode === 'POLYGON_ID' && vicAreas.areaName === 'POLYGON_NM', 'with no AREA_ID, POLYGON_ID is the area code');
  assert(ni.sniffBoundaryMapping(ADMIN4).areaCode === 'AREA_ID', '…and AREA_ID still wins where both exist');
  const vicRoads = ni.sniffNetworkMapping(VIC_ROADS);
  assert(vicRoads.linkId === null && vicRoads.linkName === 'ST_NAME', 'a road file with no id column maps no link id');

  const lineA = [[144.9631, -37.8136], [144.9641, -37.8146]];
  const lineB = [[144.9700, -37.8200], [144.9710, -37.8210], [144.9720, -37.8220]];
  const [byShape] = ni.linksOfFeature({ ST_NAME: 'Bourke St' }, [lineA], vicRoads);
  assert(byShape.fromShape && /^s[0-9a-f]{20}$/.test(byShape.id), 'no id column: the id is made from the shape');
  assert(ni.linksOfFeature({}, [lineA.map((p) => [...p])], vicRoads)[0].id === byShape.id, '…the same line gets the same id next time');
  assert(ni.linksOfFeature({}, [lineB], vicRoads)[0].id !== byShape.id, '…and a different line a different one');
  const blank = ni.linksOfFeature({ LINK_ID: '  ' }, [lineA], { linkId: 'LINK_ID' });
  assert(blank[0].id === byShape.id && blank[0].fromShape, 'a blank value in a chosen id column falls back to the shape');
  const multi = ni.linksOfFeature({ LINK_ID: '123' }, [lineA, [[1, 1]], lineB], { linkId: 'LINK_ID' });
  assert(multi.length === 2 && multi[0].id === '123' && multi[1].id === '123~2' && multi[1].coords === lineB,
    'a multi-part link is one link per part: part 1 keeps the id, later parts are id~2.., a 1-point part is dropped');
  const multiShape = ni.linksOfFeature({}, [lineA, lineB], vicRoads);
  assert(multiShape.length === 2 && multiShape[0].id !== multiShape[1].id, '…and by shape, each part its own id');

  const square = { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] };
  const code = ni.areaCodeFromShape(square);
  assert(/^A[0-9A-F]{12}$/.test(code) && code === ni.areaCodeFromShape(JSON.parse(JSON.stringify(square))),
    'an area with no code column gets a stable code from its outline');
  assert(code !== ni.areaCodeFromShape({ type: 'MultiPolygon', coordinates: [square.coordinates, [[[2, 2], [2, 3], [3, 3], [2, 2]]]] }),
    '…and a different outline a different code');

  /* ── outlines MongoDB refuses to index (the VIC commit failed on "Can't extract geo keys") ── */
  await require('../src/models/WorkArea').init();
  // Tamleugh North's rejected piece, verbatim: flat on the map, self-crossing on the sphere.
  const tamleugh = [[[145.61473, -36.5634], [145.6146922071419, -36.56333750917761], [145.5925176304242, -36.56329471264572], [145.59254, -36.5633], [145.59266, -36.56342], [145.60015, -36.56333], [145.60035, -36.56331], [145.60058, -36.56333], [145.60952, -36.56343], [145.61473, -36.5634]]];
  const box = (x, y, d) => [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]];
  const bowtie = (x, y, d) => [[[x, y], [x + d, y + d], [x + d, y], [x, y + d], [x, y]]];
  assert(!(await ni.mongoAcceptsAll([{ type: 'Polygon', coordinates: tamleugh }])), 'MongoDB rejects the Tamleugh North piece as delivered');
  const outlineAreas = [
    { name: 'Fine', geometry: { type: 'Polygon', coordinates: box(145, -37, 0.01) } },
    { name: 'Tamleugh North', geometry: { type: 'MultiPolygon', coordinates: [tamleugh, box(145.59, -36.57, 0.001)] } },
    { name: 'Kimbolton', geometry: { type: 'MultiPolygon', coordinates: [box(144.5, -36.9, 0.01), bowtie(144.52, -36.88, 0.0001)] } },
    { name: 'Big bowtie', geometry: { type: 'Polygon', coordinates: bowtie(146, -37, 0.01) } },
  ];
  const untouched = outlineAreas[0].geometry;
  const outcome = await ni.repairAreaGeometries(outlineAreas);
  assert(outlineAreas[0].geometry === untouched, 'a valid outline is not touched');
  assert(outcome.densified.join() === 'Tamleugh North' && outlineAreas[1].geometry.coordinates.length === 2,
    'a sphere-only crossing is fixed by adding points along the edges — no piece lost');
  assert(outcome.dropped.join() === 'Kimbolton' && outlineAreas[2].geometry.type === 'Polygon', 'a self-crossing crumb of a few m² is left out');
  assert(outcome.hulled.join() === 'Big bowtie', 'a large self-crossing piece is replaced by its hull, not lost');
  assert(outcome.broken.length === 0 && (await ni.mongoAcceptsAll(outlineAreas.map((a) => a.geometry))), 'every repaired outline is one MongoDB accepts');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
