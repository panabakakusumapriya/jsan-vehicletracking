// Hotel bookings: the office records the stays it books for drivers.
//
// Rules under test: the form prefills from the driver's own record (phone, project, plate); nights
// are counted from the calendar dates, never trusted from the client; a second stay sharing a night
// is refused unless forced, while back-to-back stays are fine; current/upcoming/past follow the
// viewer's today; a manager only sees their own drivers' bookings; a drivers' token is refused;
// confirmation files round-trip through GridFS and wrong types are refused; CSV exports.
//
// Run: node test/hotelBookings.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotel_bookings_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('hotel_bookings_test');

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const Vehicle = require('../src/models/Vehicle');
  const app = createApp();

  const vic = await Project.create({ name: 'Victoria' });
  const qld = await Project.create({ name: 'Queensland' });
  const van = await Vehicle.create({ plateNumber: 'HT480' });

  const mk = async (fields) => {
    const u = new User({ ...fields });
    await u.setPassword('pw123456'); await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: fields.email, password: 'pw123456' })).body.token;
    return { u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const admin = await mk({ name: 'Admin', email: 'admin@x.com', role: 'admin' });
  const manager = await mk({ name: 'Mgr', email: 'mgr@x.com', role: 'manager', projectIds: [vic._id] });
  const ali = await mk({
    name: 'Ali Azhar', email: 'ali@x.com', role: 'user', projectIds: [vic._id], project: 'Victoria',
    driverId: 'SMD016', workPhone: '+61 400 000 111', phone: '+91 1', currency: 'AUD', vehicleId: van._id,
  });
  const joel = await mk({ name: 'Joel', email: 'joel@x.com', role: 'user', projectIds: [qld._id], project: 'Queensland' });

  console.log('\n-- prefill --');
  const prof = await admin.as(request(app).get(`/api/hotels/drivers/${ali.u._id}/profile`));
  assert(prof.status === 200 && prof.body.driver.name === 'Ali Azhar', 'the profile endpoint returns the driver');
  assert(prof.body.driver.phone === '+61 400 000 111', 'the phone prefilled is the work phone they carry');
  assert(prof.body.driver.driverCode === 'SMD016' && prof.body.driver.project === 'Victoria', 'driver code and project prefill');
  assert(prof.body.driver.vehiclePlate === 'HT480' && prof.body.driver.currency === 'AUD', 'vehicle plate and currency prefill');

  const drivers = await manager.as(request(app).get('/api/hotels/drivers'));
  assert(drivers.body.drivers.length === 1 && drivers.body.drivers[0].name === 'Ali Azhar',
    "a manager's driver picker lists only drivers on their projects");
  const foreign = await manager.as(request(app).get(`/api/hotels/drivers/${joel.u._id}/profile`));
  assert(foreign.status === 403, "a manager cannot read another project's driver");

  console.log('\n-- creating --');
  const base = {
    driverId: String(ali.u._id),
    hotel: { name: 'Hampton Park Motel', address: '1 Main St', city: 'Hampton Park', lat: -38.03, lon: 145.25 },
    checkIn: '2026-10-01', checkOut: '2026-10-04', totalCost: 450, payment: 'company_card',
    bookingReference: 'BK-123', nights: 99, today: '2026-09-30',
  };
  const made = await admin.as(request(app).post('/api/hotels/bookings').send(base));
  assert(made.status === 201, 'a booking is created');
  const b1 = made.body.booking;
  assert(b1.nights === 3, 'nights are counted from the dates (3), not taken from the client (99)');
  assert(b1.costPerNight === 150, 'cost per night is worked out');
  assert(b1.currency === 'AUD', "currency defaults to the driver's");
  assert(b1.driver.phone === '+61 400 000 111' && b1.driver.vehiclePlate === 'HT480',
    'with no driver details sent, the system record is snapshotted');
  assert(b1.stayState === 'upcoming', 'before check-in it is upcoming');

  const clash = await admin.as(request(app).post('/api/hotels/bookings').send({ ...base, checkIn: '2026-10-03', checkOut: '2026-10-05' }));
  assert(clash.status === 409 && clash.body.code === 'OVERLAP' && clash.body.conflicts.length === 1,
    'a second stay sharing a night is refused, naming the clash');
  const forced = await admin.as(request(app).post('/api/hotels/bookings').send({ ...base, checkIn: '2026-10-03', checkOut: '2026-10-05', force: true }));
  assert(forced.status === 201, 'and allowed when the office says so');
  const backToBack = await admin.as(request(app).post('/api/hotels/bookings').send({
    ...base, hotel: { name: 'Next Inn' }, checkIn: '2026-10-05', checkOut: '2026-10-06',
  }));
  assert(backToBack.status === 201, 'a stay starting on the day another ends is not an overlap');

  const bad = await admin.as(request(app).post('/api/hotels/bookings').send({ ...base, checkIn: '2026-10-04', checkOut: '2026-10-04' }));
  assert(bad.status === 400, 'check-out on the check-in day is refused');
  const edited = await admin.as(request(app).post('/api/hotels/bookings').send({
    ...base, force: true, driver: { name: 'Ali Azhar', phone: '+61 499 999 999' },
  }));
  assert(edited.body.booking.driver.phone === '+61 499 999 999', 'contact details edited in the form are kept');

  const driverTry = await ali.as(request(app).get('/api/hotels/bookings'));
  assert(driverTry.status === 403, 'a driver cannot read bookings — admin side only');

  console.log('\n-- lists --');
  const cur = await admin.as(request(app).get('/api/hotels/bookings?when=current&today=2026-10-02'));
  assert(cur.body.bookings.length >= 1 && cur.body.bookings.every((b) => b.stayState === 'staying'),
    "on the 2nd the stay is 'staying now', by the viewer's today");
  const past = await admin.as(request(app).get('/api/hotels/bookings?when=past&today=2026-10-10'));
  assert(past.body.bookings.length === 4, 'after checkout they are all past');

  await admin.as(request(app).post('/api/hotels/bookings').send({
    ...base, driverId: String(joel.u._id), checkIn: '2026-11-01', checkOut: '2026-11-02',
  }));
  const mgrList = await manager.as(request(app).get('/api/hotels/bookings'));
  assert(mgrList.body.bookings.every((b) => b.driverId === String(ali.u._id)),
    "a manager's list holds only their own drivers' bookings");
  const byProject = await admin.as(request(app).get(`/api/hotels/bookings?projectId=${qld._id}`));
  assert(byProject.body.bookings.length === 1, 'filtering by project works');

  console.log('\n-- editing and cancelling --');
  const moved = await admin.as(request(app).patch(`/api/hotels/bookings/${b1._id}`).send({ checkOut: '2026-10-02', force: true }));
  assert(moved.status === 200 && moved.body.booking.nights === 1, 'moving check-out recounts the nights');
  const cancelled = await admin.as(request(app).patch(`/api/hotels/bookings/${b1._id}`).send({ status: 'cancelled' }));
  assert(cancelled.body.booking.stayState === 'cancelled' && cancelled.body.booking.cancelledByName === 'Admin',
    'cancelling records who did it');
  const cList = await admin.as(request(app).get('/api/hotels/bookings?when=cancelled'));
  assert(cList.body.bookings.length === 1, 'cancelled stays have their own view');

  console.log('\n-- confirmation files --');
  const pdf = Buffer.from('%PDF-1.4 fake confirmation');
  const up = await admin.as(request(app).post(`/api/hotels/bookings/${backToBack.body.booking._id}/attachments`))
    .set('Content-Type', 'application/pdf').set('X-File-Name', encodeURIComponent('Booking confirmation.pdf')).send(pdf);
  assert(up.status === 201 && up.body.booking.attachments.length === 1, 'a PDF attaches');
  const att = up.body.booking.attachments[0];
  assert(att.filename === 'Booking confirmation.pdf' && att.bytes === pdf.length, 'with its name and size');
  const down = await admin.as(request(app).get(`/api/hotels/bookings/${backToBack.body.booking._id}/attachments/${att._id}`))
    .buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert(down.status === 200 && Buffer.compare(down.body, pdf) === 0, 'and downloads byte for byte');
  const exe = await admin.as(request(app).post(`/api/hotels/bookings/${backToBack.body.booking._id}/attachments`))
    .set('Content-Type', 'application/x-msdownload').send(Buffer.from('MZ'));
  assert(exe.status === 415, 'anything but a PDF or image is refused');
  const del = await admin.as(request(app).delete(`/api/hotels/bookings/${backToBack.body.booking._id}/attachments/${att._id}`));
  assert(del.status === 200 && del.body.booking.attachments.length === 0, 'a file can be removed');

  console.log('\n-- export --');
  const csv = await admin.as(request(app).get('/api/hotels/bookings/export.csv?today=2026-09-30'));
  assert(csv.status === 200 && /text\/csv/.test(csv.headers['content-type']), 'the CSV exports');
  assert(csv.text.split('\n')[0].startsWith('Driver,Driver ID') && csv.text.includes('Hampton Park Motel'),
    'with a header row and the bookings in it');

  console.log(`\n🎉 HOTEL BOOKINGS — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
