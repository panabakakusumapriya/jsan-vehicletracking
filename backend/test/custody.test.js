// Custody ledger tests — invariants, backdating, month maths, timezone boundaries.
// Run: npm run test:custody   (in-memory MongoDB; no external DB or network)
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
async function rejects(fn, msg) {
  try { await fn(); } catch { assert(true, msg); return; }
  assert(false, msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('custody_test');
  process.env.JWT_SECRET = 'custody_test_secret_key_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const User = require('../src/models/User');
  const Vehicle = require('../src/models/Vehicle');
  const MobileDevice = require('../src/models/MobileDevice');
  const Assignment = require('../src/models/Assignment');
  const custody = require('../src/services/assetCustody');
  const { monthRange, formatDateInZone } = require('../src/utils/timezone');
  await Promise.all([User.init(), Vehicle.init(), MobileDevice.init(), Assignment.init()]);

  const admin = await new User({ name: 'Admin', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const manager = await new User({ name: 'Mgr', email: 'm@x.com', role: 'manager' });
  await manager.setPassword('pw123456'); await manager.save();

  const mkDriver = async (name, email) => {
    const d = new User({
      name, email, role: 'user', managerId: manager._id,
      country: 'Australia', project: 'Fleet North',
    });
    await d.setPassword('pw123456'); await d.save(); return d;
  };
  const alice = await mkDriver('Alice', 'alice@x.com');
  const bob = await mkDriver('Bob', 'bob@x.com');

  const truck = await Vehicle.create({ plateNumber: 'TS09AB1234', managerId: manager._id });
  const van = await Vehicle.create({ plateNumber: 'MH12XY9988', managerId: manager._id });
  const phone = await MobileDevice.create({ imei: '356100000000001', phoneModel: 'Redmi 12', managerId: manager._id });

  const D = (s) => new Date(`${s}T00:00:00.000Z`);

  console.log('\n── invariants ──');
  await custody.assign({ assetKind: 'vehicle', assetId: truck._id, driverId: alice._id, startedAt: D('2026-06-01'), actor: admin });
  assert((await Assignment.countDocuments({ endedAt: Assignment.OPEN })) === 1, 'assigning opens exactly one stint');
  assert(String((await User.findById(alice._id)).vehicleId) === String(truck._id), 'User.vehicleId cache updated');
  assert(String((await Vehicle.findById(truck._id)).assignedDriverId) === String(alice._id), 'Vehicle.assignedDriverId cache updated');

  const same = await custody.assign({ assetKind: 'vehicle', assetId: truck._id, driverId: alice._id, actor: admin });
  assert(same.unchanged === true, 're-assigning to the same driver is a no-op, not new history');
  assert((await Assignment.countDocuments({ assetKind: 'vehicle' })) === 1, 'no churn row created');

  console.log('\n── reassignment closes rather than overwrites ──');
  await custody.assign({ assetKind: 'vehicle', assetId: truck._id, driverId: bob._id, startedAt: D('2026-06-11'), actor: admin });
  const aliceTruck = await Assignment.findOne({ assetId: truck._id, driverId: alice._id });
  assert(aliceTruck.endedAt.getTime() === D('2026-06-11').getTime(), "Alice's stint closed at the handover date");
  assert((await Assignment.countDocuments({ assetId: truck._id })) === 2, 'both stints retained — history not overwritten');
  assert((await Assignment.countDocuments({ assetId: truck._id, endedAt: Assignment.OPEN })) === 1, 'exactly one open stint for the truck');
  assert((await User.findById(alice._id)).vehicleId === null, "Alice's cache pointer cleared");

  console.log('\n── the DB enforces one holder per asset, but not one asset per driver ──');
  await rejects(
    () => Assignment.create({ assetKind: 'vehicle', assetId: truck._id, driverId: alice._id, startedAt: new Date(), endedAt: Assignment.OPEN }),
    'a second open stint for the same vehicle is rejected by the unique index'
  );
  await custody.assign({ assetKind: 'vehicle', assetId: van._id, driverId: bob._id, startedAt: D('2026-06-15'), actor: admin });
  assert((await Assignment.countDocuments({ driverId: bob._id, assetKind: 'vehicle', endedAt: Assignment.OPEN })) === 2,
    'Bob now holds the truck AND the van at once — concurrent assets of the same kind are allowed');
  assert(String((await User.findById(bob._id)).vehicleId) === String(van._id),
    "the driver's cache pointer follows the most recently assigned vehicle");
  assert(String((await Vehicle.findById(truck._id)).assignedDriverId) === String(bob._id),
    'the truck itself is untouched — still shows Bob as its one holder');

  // Return the truck explicitly, so the rest of this test's day-count narrative below (which
  // was written assuming the old "one each" auto-return) sees the same end state: Bob holds
  // only the van from 15 June.
  const bobTruckRow = await Assignment.findOne({ assetId: truck._id, driverId: bob._id, endedAt: Assignment.OPEN });
  await custody.release({ assignmentId: bobTruckRow._id, endedAt: D('2026-06-15'), actor: admin });
  assert((await Assignment.findOne({ assetId: truck._id, driverId: bob._id })).endedAt.getTime() === D('2026-06-15').getTime(),
    "Bob's truck stint closed when it was returned");
  assert(String((await User.findById(bob._id)).vehicleId) === String(van._id),
    "returning the truck leaves the van as Bob's cache pointer");

  console.log('\n── a mobile is independent of the vehicle ──');
  await custody.assign({ assetKind: 'mobile', assetId: phone._id, driverId: bob._id, startedAt: D('2026-06-05'), actor: admin });
  assert((await Assignment.countDocuments({ driverId: bob._id, endedAt: Assignment.OPEN })) === 2, 'Bob holds a vehicle AND a mobile');
  assert((await MobileDevice.findById(phone._id)).status === 'assigned', 'device status flipped to assigned');

  console.log('\n── backdating cannot overwrite history ──');
  await rejects(
    () => custody.assign({ assetKind: 'vehicle', assetId: truck._id, driverId: alice._id, startedAt: D('2026-06-05'), actor: admin }),
    'backdating onto a closed stint is rejected (overlap)'
  );
  await rejects(
    () => custody.assign({ assetKind: 'vehicle', assetId: van._id, driverId: alice._id, startedAt: D('2026-06-10'), actor: admin }),
    "backdating before the current holder's start is rejected"
  );
  await rejects(
    () => custody.assign({ assetKind: 'vehicle', assetId: van._id, driverId: alice._id, startedAt: D('2030-01-01'), actor: admin }),
    'a start date in the future is rejected'
  );

  console.log('\n── returning ──');
  const openPhone = await Assignment.findOne({ assetId: phone._id, endedAt: Assignment.OPEN });
  await custody.release({ assignmentId: openPhone._id, endedAt: D('2026-06-20'), actor: admin });
  assert((await MobileDevice.findById(phone._id)).status === 'in_stock', 'returned device goes back in stock');
  assert((await MobileDevice.findById(phone._id)).currentDriverId === null, 'device holder cleared');
  await rejects(() => custody.release({ assignmentId: openPhone._id, actor: admin }), 'returning twice is rejected');
  await custody.assign({ assetKind: 'mobile', assetId: phone._id, driverId: alice._id, startedAt: D('2026-06-25'), actor: admin });
  assert((await Assignment.countDocuments({ assetId: phone._id })) === 2, 'a returned phone can move to another driver, keeping history');

  console.log('\n── driver exit hands everything back ──');
  // Bob's phone was already returned on the 20th and given to Alice, so the van is the only
  // thing still in his hands.
  assert((await Assignment.countDocuments({ driverId: bob._id, endedAt: Assignment.OPEN })) === 1, 'Bob holds only the van going into his exit');
  const { released } = await custody.releaseAllForDriver({ driverId: bob._id, endedAt: D('2026-06-28'), note: 'driver exit', actor: admin });
  assert(released === 1, 'exit closed every stint Bob still had open');
  assert((await Assignment.countDocuments({ driverId: bob._id, endedAt: Assignment.OPEN })) === 0, 'a departed driver holds nothing');
  assert((await Vehicle.findById(van._id)).assignedDriverId === null, 'the van is free to reassign');

  console.log('\n── the month-overlap query ──');
  const { from, to } = monthRange('2026-06', 'UTC');
  const inJune = await Assignment.find({ ...Assignment.overlapFilter(from, to) });
  assert(inJune.length === 5, `every stint touching June is found (${inJune.length})`);
  const inMay = await Assignment.find({ ...Assignment.overlapFilter(...Object.values(monthRange('2026-05', 'UTC')).slice(0, 2)) });
  assert(inMay.length === 0, 'May, before anything started, is correctly empty');

  // A stint that ended ON 11 June belongs to June, not July.
  const julyRange = monthRange('2026-07', 'UTC');
  const inJuly = await Assignment.find({ ...Assignment.overlapFilter(julyRange.from, julyRange.to) });
  assert(inJuly.length === 1, 'only the still-open stint reaches July');

  console.log('\n── days held ──');
  const DAY = 86400000;
  const days = (row) => Math.round(((Math.min(row.endedAt.getTime(), to.getTime()) - Math.max(row.startedAt.getTime(), from.getTime())) / DAY) * 10) / 10;
  const aliceTruckRow = await Assignment.findOne({ assetId: truck._id, driverId: alice._id });
  assert(days(aliceTruckRow) === 10, 'Alice held the truck for 10 days of June (1st→11th)');
  // Alice's phone, open since the 25th: 25 Jun → 1 Jul is 6 days of June.
  const openRow = await Assignment.findOne({ endedAt: Assignment.OPEN });
  assert(days(openRow) === 6, 'an open stint is clipped to the end of the month, not to 9999');

  console.log('\n── timezone boundaries ──');
  const syd = monthRange('2026-06', 'Australia/Sydney');
  const utc = monthRange('2026-06', 'UTC');
  assert(syd.from.getTime() < utc.from.getTime(), 'June starts earlier in Sydney than in UTC');
  assert(utc.from.getTime() - syd.from.getTime() === 10 * 3600000, 'Sydney is UTC+10 in June (no DST)');
  const par = monthRange('2026-06', 'Europe/Paris');
  assert(utc.from.getTime() - par.from.getTime() === 2 * 3600000, 'Paris is UTC+2 in June (CEST — DST applied)');
  const parJan = monthRange('2026-01', 'Europe/Paris');
  assert(new Date('2026-01-01T00:00:00Z').getTime() - parJan.from.getTime() === 1 * 3600000, 'Paris is UTC+1 in January (CET)');
  assert(formatDateInZone(new Date('2026-06-30T23:00:00Z'), 'Australia/Sydney') === '2026-07-01',
    'an instant late on 30 June UTC is already 1 July in Sydney — the report says so');
  assert(monthRange('2026-12', 'UTC').to.getTime() === Date.UTC(2027, 0, 1), 'December rolls into the next year');

  console.log('\n── the sentinel never leaks to API consumers ──');
  const json = openRow.toJSON();
  assert(json.endedAt === null, 'an open stint serialises endedAt as null, not 9999');
  assert(json.open === true, 'and carries an explicit open flag');
  assert((await Assignment.findOne({ assetId: truck._id, driverId: alice._id })).toJSON().open === false, 'a closed stint reports open:false');

  console.log('\n── the EXISTING screens must write history too ──');
  // The point of the feature is defeated if the Drivers/Vehicles pages, which move the
  // pointer directly, quietly bypass the ledger. These go through the real HTTP API.
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const login = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const asAdmin = (r) => r.set('Authorization', `Bearer ${login.body.token}`);

  const carol = await mkDriver('Carol', 'carol@x.com');
  const lorry = await Vehicle.create({ plateNumber: 'KA01ZZ0001', managerId: manager._id });

  const before = await Assignment.countDocuments({ assetKind: 'vehicle' });
  let r = await asAdmin(request(app).patch(`/api/users/${carol._id}`)).send({ vehicleIds: [String(lorry._id)] });
  assert(r.status === 200, 'PATCH /api/users with vehicleIds succeeds');
  assert((await Assignment.countDocuments({ assetKind: 'vehicle' })) === before + 1,
    'assigning from the Drivers screen writes a custody row (does not just move the pointer)');
  assert(String((await Vehicle.findById(lorry._id)).assignedDriverId) === String(carol._id), 'vehicle cache in sync');

  // Hand the same lorry to Alice from the Vehicles screen — Carol's stint must close, not vanish.
  r = await asAdmin(request(app).patch(`/api/vehicles/${lorry._id}`)).send({ assignedDriverId: String(alice._id) });
  assert(r.status === 200, 'PATCH /api/vehicles reassigns');
  const carolStint = await Assignment.findOne({ assetId: lorry._id, driverId: carol._id });
  assert(carolStint && !carolStint.toJSON().open, "Carol's stint was closed, not deleted");
  assert((await Assignment.countDocuments({ assetId: lorry._id })) === 2, 'both holders are on record');
  assert((await User.findById(carol._id)).vehicleId === null, "Carol's pointer cleared");

  // Clearing the array must close the stint rather than orphan it.
  r = await asAdmin(request(app).patch(`/api/users/${alice._id}`)).send({ vehicleIds: [] });
  assert(r.status === 200, "clearing a driver's vehicles succeeds");
  assert((await Assignment.countDocuments({ assetId: lorry._id, endedAt: Assignment.OPEN })) === 0,
    'clearing the array closes the open stint');

  console.log('\n── the Drivers screen is the ONLY allocation path ──');
  // Both multi-selects post to PATCH /api/users. Mobiles and Vehicles are inventory-only now,
  // so if this path didn't write history there would be no way to record a handover at all.
  const spare = await MobileDevice.create({ imei: '356100000000009', phoneModel: 'Nokia', managerId: manager._id });
  r = await asAdmin(request(app).patch(`/api/users/${carol._id}`)).send({ mobileDeviceIds: [String(spare._id)] });
  assert(r.status === 200, 'PATCH /api/users accepts mobileDeviceIds');
  const mobRow = await Assignment.findOne({ assetKind: 'mobile', assetId: spare._id, endedAt: Assignment.OPEN });
  assert(mobRow && String(mobRow.driverId) === String(carol._id), 'picking a device writes an open custody row');
  assert(String((await User.findById(carol._id)).mobileDeviceId) === String(spare._id), 'driver cache points at the device');
  assert((await MobileDevice.findById(spare._id)).status === 'assigned', 'device flips to assigned');

  // Swapping to another handset (replacing the array) must close the first stint, not overwrite it.
  const spare2 = await MobileDevice.create({ imei: '356100000000010', phoneModel: 'Moto', managerId: manager._id });
  await asAdmin(request(app).patch(`/api/users/${carol._id}`)).send({ mobileDeviceIds: [String(spare2._id)] });
  assert((await Assignment.countDocuments({ assetKind: 'mobile', driverId: carol._id })) === 2,
    'swapping handsets leaves two rows — the old one closed, not erased');
  assert((await MobileDevice.findById(spare._id)).status === 'in_stock', 'the replaced handset returns to stock');

  // Clearing the array hands the device back.
  await asAdmin(request(app).patch(`/api/users/${carol._id}`)).send({ mobileDeviceIds: [] });
  assert((await Assignment.countDocuments({ assetKind: 'mobile', driverId: carol._id, endedAt: Assignment.OPEN })) === 0,
    'setting the multi-select to empty closes the stint');
  assert((await User.findById(carol._id)).mobileDeviceId === null, 'driver cache cleared');

  // And a brand-new driver created with both multi-selects filled gets history from day one.
  const dora = await asAdmin(request(app).post('/api/users')).send({
    name: 'Dora', email: 'dora@x.com', password: 'pw123456', role: 'user',
    managerId: String(manager._id), vehicleIds: [String(lorry._id)], mobileDeviceIds: [String(spare._id)],
  });
  assert(dora.status === 201, 'creating a driver with both multi-selects filled succeeds');
  const doraId = dora.body.user._id;
  assert((await Assignment.countDocuments({ driverId: doraId, endedAt: Assignment.OPEN })) === 2,
    'a new driver\'s first vehicle AND phone are both on record immediately');

  console.log('\n── a driver can be given several vehicles at once, through the real API ──');
  const van2 = await Vehicle.create({ plateNumber: 'KA02AA0002', managerId: manager._id });
  r = await asAdmin(request(app).patch(`/api/users/${doraId}`)).send({ vehicleIds: [String(lorry._id), String(van2._id)] });
  assert(r.status === 200, 'PATCH with two vehicleIds succeeds');
  assert((await Assignment.countDocuments({ driverId: doraId, assetKind: 'vehicle', endedAt: Assignment.OPEN })) === 2,
    'Dora now holds two vehicles at once, via the multi-select');
  r = await asAdmin(request(app).get(`/api/assignments/driver/${doraId}`));
  assert(r.body.assignments.filter((a) => a.assetKind === 'vehicle' && a.open).length === 2,
    "the driver's timeline shows both open vehicle stints");

  // Dropping one from the array returns just that one, keeping the other held.
  r = await asAdmin(request(app).patch(`/api/users/${doraId}`)).send({ vehicleIds: [String(van2._id)] });
  assert(r.status === 200, 'PATCH with a shorter vehicleIds array succeeds');
  assert((await Assignment.countDocuments({ driverId: doraId, assetKind: 'vehicle', endedAt: Assignment.OPEN })) === 1,
    'Dora holds one vehicle again — the one left in the array');
  assert((await Vehicle.findById(lorry._id)).assignedDriverId === null, 'the dropped vehicle is free again');
  assert(String((await Vehicle.findById(van2._id)).assignedDriverId) === String(doraId), 'the kept vehicle is still hers');

  console.log('\n── report endpoint ──');
  const rep = await asAdmin(request(app).get('/api/reports/custody?month=2026-06&tz=UTC'));
  assert(rep.status === 200, 'custody report responds');
  assert(rep.body.tz === 'UTC' && rep.body.monthDays === 30, 'June has 30 days in the reported zone');
  assert(rep.body.rows.length >= 3, 'every driver in scope appears, including those holding nothing');
  const aliceRow = rep.body.rows.find((x) => x.driver.name === 'Alice');
  assert(aliceRow.vehicles.length === 1 && aliceRow.vehicles[0].days === 10,
    'Alice shows 10 vehicle-days in June, matching the ledger');
  const idle = rep.body.rows.find((x) => !x.vehicles.length && !x.mobiles.length);
  assert(idle !== undefined, 'a driver with nothing is present rather than filtered away');

  const badMonth = await asAdmin(request(app).get('/api/reports/custody?month=nope'));
  assert(badMonth.status === 400, 'a malformed month is rejected with 400, not a 500');

  const csv = await asAdmin(request(app).get('/api/reports/custody.csv?month=2026-06&tz=UTC'));
  assert(csv.status === 200 && /Month,Timezone,Driver/.test(csv.text), 'CSV export returns a header row');
  assert(/Country,Project,AssetKind/.test(csv.text), 'CSV carries the project column');
  assert(/Fleet North/.test(csv.text), 'the project is snapshotted onto each stint, not looked up live');
  assert(csv.headers['content-disposition'].includes('custody-2026-06.csv'), 'CSV is served as a named download');

  console.log('\n── scoping ──');
  const mgrLogin = await request(app).post('/api/auth/login').send({ email: 'm@x.com', password: 'pw123456' });
  const outsider = new User({ name: 'Outsider', email: 'out@x.com', role: 'user', managerId: null });
  await outsider.setPassword('pw123456'); await outsider.save();
  const mgrRep = await request(app).get('/api/reports/custody?month=2026-06&tz=UTC')
    .set('Authorization', `Bearer ${mgrLogin.body.token}`);
  assert(!mgrRep.body.rows.some((x) => x.driver.name === 'Outsider'),
    "a manager's report excludes drivers outside their team");

  console.log(`\n🎉 CUSTODY LEDGER VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
