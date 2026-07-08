/**
 * Seed script: creates a first admin (and an optional demo manager + driver + vehicle).
 * Run: npm run seed
 * Idempotent — re-running updates the seeded records rather than duplicating them.
 */
const mongoose = require('mongoose');
const env = require('../config/env');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');

async function upsertUser({ email, name, password, role, managerId = null }) {
  let user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    user = new User({ email, name, role, managerId });
    await user.setPassword(password);
    await user.save();
    console.log(`  + created ${role}: ${email}`);
  } else {
    console.log(`  = ${role} already exists: ${email}`);
  }
  return user;
}

async function run() {
  await connectDB();
  console.log('Seeding…');

  const admin = await upsertUser({
    email: env.SEED_ADMIN_EMAIL,
    name: env.SEED_ADMIN_NAME,
    password: env.SEED_ADMIN_PASSWORD,
    role: 'admin',
  });

  // Demo manager + driver + vehicle so the admin panel & app have something to show.
  const manager = await upsertUser({
    email: 'manager@jsan.local',
    name: 'Demo Manager',
    password: 'Manager@12345',
    role: 'manager',
  });

  const driver = await upsertUser({
    email: 'driver@jsan.local',
    name: 'Demo Driver',
    password: 'Driver@12345',
    role: 'user',
    managerId: manager._id,
  });

  let vehicle = await Vehicle.findOne({ plateNumber: 'JSAN-0001' });
  if (!vehicle) {
    vehicle = await Vehicle.create({
      plateNumber: 'JSAN-0001',
      model: 'Demo Truck',
      managerId: manager._id,
      assignedDriverId: driver._id,
    });
    console.log('  + created vehicle: JSAN-0001');
  }
  if (String(driver.vehicleId) !== String(vehicle._id)) {
    driver.vehicleId = vehicle._id;
    await driver.save();
  }

  console.log('\nDone. Logins:');
  console.log(`  admin   : ${admin.email} / ${env.SEED_ADMIN_PASSWORD}`);
  console.log('  manager : manager@jsan.local / Manager@12345');
  console.log('  driver  : driver@jsan.local / Driver@12345');

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
