// Driver-dropped markers reach every screen that shows the drive: the trip map, the Trips page's
// driver-day rows, and the Coverage map.
//
// Drivers stop to flag a spot — often after the trip has just ended or before the next one starts,
// and an offline drop uploads later, sometimes during the NEXT trip. So markers are matched to
// trips and days by WHEN they were dropped, not only by the trip that happened to be running when
// the upload arrived.
//
// Run: node test/markersEverywhere.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

const MIN = 60 * 1000;

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('markers_everywhere_test');
  process.env.JWT_SECRET = 'markers_everywhere_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const Marker = require('../src/models/Marker');
  const MarkerCategory = require('../src/models/MarkerCategory');
  const app = createApp();

  const mk = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return { u, get: (p) => auth(request(app).get(p)), post: (p, b) => auth(request(app).post(p)).send(b) };
  };
  const admin = await mk('admin@x.com', 'admin');
  const drv = await mk('drv@x.com', 'user');
  const other = await mk('other@x.com', 'user');
  const red = await MarkerCategory.create({ name: 'Red Flag', color: '#ef4444', order: 1 });
  const blue = await MarkerCategory.create({ name: 'Blue Marker', color: '#4285f4', order: 2 });

  const at = (hhmm) => new Date(`2026-10-01T${hhmm}:00Z`);
  const t1 = await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: at('09:00'), endedAt: at('10:00'), distanceMeters: 5000 });
  const t2 = await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: at('14:00'), endedAt: at('15:00'), distanceMeters: 5000 });

  console.log('\n── dropping: linked by when it was pressed ──');
  const drop = (cat, hhmm, lat = -37.8, lon = 144.9) =>
    drv.post('/api/markers', { lat, lon, categoryId: String(cat._id), clientId: `c-${hhmm}-${cat.name}`, recordedAt: at(hhmm).toISOString() });
  const inTrip = await drop(red, '09:30');
  assert(inTrip.status === 201 && inTrip.body.marker.tripId === String(t1._id), 'a marker dropped during a trip — uploaded long after — is linked to that trip');
  const justAfter = await drop(blue, '10:05');
  assert(justAfter.body.marker.tripId === String(t1._id), 'one dropped 5 minutes after the trip ended (the driver stopped to flag it) is linked to it too');
  const between = await drop(red, '12:00');
  assert(between.body.marker.tripId === null, 'one dropped hours from any trip is not forced onto one');
  await drop(blue, '14:20', -36.85, 174.76);

  // Markers saved without a client id (not the app's path, but any other) must all save: a null
  // default on the sparse-unique clientId index made every second one a duplicate-key error.
  await Marker.create({ driverId: drv.u._id, categoryId: blue._id, lat: 1, lon: 1, recordedAt: at('03:00') });
  await Marker.create({ driverId: drv.u._id, categoryId: blue._id, lat: 1, lon: 1, recordedAt: at('03:01') });
  assert((await Marker.countDocuments({ lat: 1 })) === 2, 'two markers without a client id both save');
  await Marker.deleteMany({ lat: 1 });

  console.log('\n── the trip map ──');
  // An old marker stamped before this change (no tripId) inside the trip's time still shows.
  await Marker.create({ driverId: drv.u._id, categoryId: red._id, lat: -37.8, lon: 144.9, recordedAt: at('09:45'), tripId: null });
  const trip1 = await admin.get(`/api/markers?tripId=${t1._id}`);
  assert(trip1.body.markers.length === 3, 'trip 1 shows its 3 markers: stamped, dropped just after, and an unstamped old one inside its time');
  const trip2 = await admin.get(`/api/markers?tripId=${t2._id}`);
  assert(trip2.body.markers.length === 1, 'trip 2 shows only its own marker, not trip 1\'s');
  assert((await other.get(`/api/markers?tripId=${t1._id}`)).status === 403, 'a driver cannot read the staff marker list');

  console.log('\n── the Trips page day row ──');
  const sum = await admin.get('/api/trips/merged-summary');
  const day = sum.body.summaries.find((s) => s.date === '2026-10-01');
  assert(day.markerCount === 5, 'the driver-day counts all 5 markers of the day — between-trip ones included');
  const reds = day.markerColors.find((c) => c.color === '#ef4444');
  assert(reds && reds.count === 3, '…split by colour, so the row can show the red / blue dots');
  const list = await admin.get(`/api/markers?driverId=${drv.u._id}&date=2026-10-01&tz=UTC`);
  assert(list.body.markers.length === 5 && list.body.markers[0].category.name === 'Red Flag', 'the expanded day lists them in order, with their category');
  const nextDay = await admin.get(`/api/markers?driverId=${drv.u._id}&date=2026-10-02&tz=UTC`);
  assert(nextDay.body.markers.length === 0, 'and only that day\'s');

  console.log('\n── the Coverage map ──');
  const nz = await admin.get('/api/markers?days=365&bbox=174,-37.5,175.5,-36');
  assert(nz.body.markers.length === 1 && nz.body.markers[0].lat === -36.85, 'a map extent returns the markers inside it only');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
