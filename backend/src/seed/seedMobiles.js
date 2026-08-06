/**
 * Seed mobile devices and assign them to matching drivers.
 *
 *   npm run seed:mobiles -- --dry-run    preview, touches nothing
 *   npm run seed:mobiles                 clear existing mobiles, insert seed data,
 *                                        assign to matching drivers
 *
 * Clears ALL MobileDevice documents, mobile Assignment records, and driver
 * mobileDeviceId caches before inserting. Does NOT touch other collections.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const MobileDevice = require('../models/MobileDevice');
const Assignment = require('../models/Assignment');
const User = require('../models/User');

const DEVICES = [
  {
    country: 'AT',
    driverName: 'Houssein Marega',
    workMail: 'houssein.marega@field-ops-xpense-it.com',
    workPhone: '43 6703505221',
    imei: '353420940115341',
    secondaryImei: '353420940115360',
    phoneModel: 'Google Pixel 9',
    androidVersion: '17',
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'Nikolay Didov',
    workMail: 'nikolay.didov1@field-ops-xpense-it.com',
    workPhone: '43 69010705506',
    imei: '353420940116364',
    secondaryImei: null,
    phoneModel: 'Google Pixel 9',
    androidVersion: '16',
    phoneCase: 'Yes',
    phoneScreenguard: 'No',
  },
  {
    country: 'AT',
    driverName: 'BOHDAN LESHCHENKO',
    workMail: 'bohdan.leshchenko@field-ops-xpense-it.com',
    workPhone: '43 6766074734',
    imei: '352207822098989',
    secondaryImei: null,
    phoneModel: 'Google Pixel 9',
    androidVersion: '16',
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'YANG GUANG',
    workMail: 'yang.guang@field-ops-xpense-it.com',
    workPhone: '43 670 2037704',
    imei: '354965919886305',
    secondaryImei: '354965919886313',
    phoneModel: 'Google Pixel 9',
    androidVersion: '16',
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'Tiago Manuel',
    workMail: 'tiago.manuel@field-ops-xpense-it.com',
    workPhone: '43 66499504623',
    imei: '353420940111134',
    secondaryImei: null,
    phoneModel: 'Google Pixel 9',
    androidVersion: null,
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'Borislav Stoyanov',
    workMail: 'borislav.stoyanov2@field-ops-xpense-it.com',
    workPhone: '43 67763896155',
    imei: '3534209401163360',
    secondaryImei: null,
    phoneModel: 'Google Pixel 9',
    androidVersion: null,
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'Nikolay Didov',
    workMail: 'nikolay.didov1@field-ops-xpense-it.com',
    workPhone: '43 6767164162',
    imei: '353420940114781',
    secondaryImei: '353420940114799',
    phoneModel: 'Google Pixel 9',
    androidVersion: '17',
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
  {
    country: 'AT',
    driverName: 'Nikolay Didov',
    workMail: 'nikolay.didov1@field-ops-xpense-it.com',
    workPhone: null,
    imei: '354965919880043',
    secondaryImei: '354965919880050',
    phoneModel: 'Google Pixel 9',
    androidVersion: null,
    phoneCase: 'Yes',
    phoneScreenguard: 'Yes',
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  await connectDB();
  console.log('Connected to MongoDB');

  const allDrivers = await User.find({ role: 'user' });
  console.log(`Found ${allDrivers.length} driver(s) in the database`);

  if (dryRun) {
    console.log('\n=== DRY RUN — no changes will be made ===\n');
    for (const d of DEVICES) {
      const driver = allDrivers.find(u => u.name.toLowerCase() === d.driverName.toLowerCase());
      console.log(`  ${d.driverName} — IMEI ${d.imei} → ${driver ? `driver "${driver.name}" (${driver.email})` : 'NO MATCHING DRIVER'}`);
    }
    console.log(`\nWould clear existing mobiles and insert ${DEVICES.length} devices.`);
  } else {
    // Clean existing mobile data
    const deletedDevices = await MobileDevice.deleteMany({});
    console.log(`Removed ${deletedDevices.deletedCount} mobile device(s)`);
    const deletedAssignments = await Assignment.deleteMany({ assetKind: 'mobile' });
    console.log(`Removed ${deletedAssignments.deletedCount} mobile assignment(s)`);
    await User.updateMany({ mobileDeviceId: { $ne: null } }, { $set: { mobileDeviceId: null } });

    const now = new Date();
    let assigned = 0;

    for (const d of DEVICES) {
      const driver = allDrivers.find(u => u.name.toLowerCase() === d.driverName.toLowerCase());

      const device = await MobileDevice.create({
        ...d,
        status: driver ? 'assigned' : 'in_stock',
        currentDriverId: driver ? driver._id : null,
      });

      if (driver) {
        await Assignment.create({
          assetKind: 'mobile',
          assetId: device._id,
          driverId: driver._id,
          startedAt: now,
          endedAt: Assignment.OPEN,
          managerId: driver.managerId || null,
          country: driver.country || d.country || null,
          project: driver.project || null,
          assetLabel: device.displayLabel(),
          driverName: driver.name,
        });
        await User.updateOne({ _id: driver._id }, { $set: { mobileDeviceId: device._id } });
        console.log(`  ✓ ${d.driverName} — IMEI ${d.imei} → assigned to "${driver.name}"`);
        assigned++;
      } else {
        console.log(`  · ${d.driverName} — IMEI ${d.imei} → in stock (no matching driver)`);
      }
    }

    console.log(`\nInserted ${DEVICES.length} device(s), ${assigned} assigned, ${DEVICES.length - assigned} in stock.`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
