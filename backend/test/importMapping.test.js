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

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
