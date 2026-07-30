/**
 * One-time backfill: turn today's assignments into the first rows of custody history.
 *
 *   npm run backfill:custody -- --dry-run     preview; writes NOTHING
 *   npm run backfill:custody                  apply
 *
 * Safe to re-run: it only creates what is missing (matched on the open assignment for each
 * asset), so a second run reports "already recorded" rather than duplicating.
 *
 * It does NOT drop the mobile fields from User — that is the one-way door and ships
 * separately, after the new screens have been proven against real data.
 *
 * On dates: for vehicles we have real evidence. Trip records already store `vehicleId`, so a
 * driver's FIRST trip in the vehicle they currently hold is a genuine start date. Where no
 * such trip exists — and always for phones, which leave no trace — the row is marked
 * `backfilled: true` and the UI shows "since at least …" rather than presenting a guess as
 * fact. See §7 of docs/asset-custody-design.md.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const Trip = require('../models/Trip');
const MobileDevice = require('../models/MobileDevice');
const Assignment = require('../models/Assignment');

const MOBILE_FIELDS = [
  'workPhone', 'imei', 'secondaryImei', 'phoneModel', 'androidVersion', 'phoneCase', 'phoneScreenguard',
];
const dryRun = process.argv.includes('--dry-run');

const log = (...a) => console.log(...a);
function section(title) {
  log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function hasMobileData(user) {
  return MOBILE_FIELDS.some((f) => user[f]);
}

async function run() {
  await connectDB();
  log(`\n${dryRun ? '🔍 DRY RUN — nothing will be written' : '✍️  APPLYING backfill'}`);

  const drivers = await User.find({ role: 'user' }).sort({ name: 1 });
  const stats = {
    devicesCreated: 0, devicesExisting: 0,
    vehicleStints: 0, vehicleFromTrip: 0, vehicleGuessed: 0,
    mobileStints: 0, skipped: 0,
  };
  const problems = [];

  /* ── 1. Devices ───────────────────────────────────────────────────────── */
  section('1. Mobile devices (from the fields currently on each driver)');

  const deviceByDriver = new Map();
  const imeiOwners = new Map(); // imei -> [driver names]  — collision detector

  for (const d of drivers) {
    if (!hasMobileData(d)) continue;

    if (d.imei) {
      if (!imeiOwners.has(d.imei)) imeiOwners.set(d.imei, []);
      imeiOwners.get(d.imei).push(d.name);
    }

    // Match an existing device on IMEI first, then the SIM number.
    const query = d.imei ? { imei: d.imei } : d.workPhone ? { workPhone: d.workPhone } : null;
    let device = query ? await MobileDevice.findOne(query) : null;

    if (device) {
      stats.devicesExisting += 1;
      log(`  = exists  ${device.displayLabel().padEnd(30)} (held by ${d.name})`);
    } else {
      const doc = {
        imei: d.imei || null,
        secondaryImei: d.secondaryImei || null,
        workPhone: d.workPhone || null,
        phoneModel: d.phoneModel || null,
        androidVersion: d.androidVersion || null,
        phoneCase: d.phoneCase || null,
        phoneScreenguard: d.phoneScreenguard || null,
        managerId: d.managerId || null,
        country: d.country || null,
        status: 'assigned',
        currentDriverId: d._id,
      };
      if (dryRun) {
        device = new MobileDevice(doc); // not saved — just for the label
      } else {
        try {
          device = await MobileDevice.create(doc);
        } catch (err) {
          if (err.code === 11000) {
            problems.push(`IMEI ${d.imei} collided while creating a device for ${d.name}`);
            continue;
          }
          throw err;
        }
      }
      stats.devicesCreated += 1;
      log(`  + create  ${device.displayLabel().padEnd(30)} (held by ${d.name})`);
    }
    deviceByDriver.set(String(d._id), device);
  }

  for (const [imei, owners] of imeiOwners) {
    if (owners.length > 1) {
      problems.push(`IMEI ${imei} is recorded against ${owners.length} drivers: ${owners.join(', ')}`);
    }
  }

  /* ── 2. Vehicle stints ────────────────────────────────────────────────── */
  section('2. Vehicle custody (start date from the first trip in that vehicle)');

  for (const d of drivers) {
    if (!d.vehicleId) continue;

    const existing = await Assignment.findOne({
      assetKind: 'vehicle', assetId: d.vehicleId, endedAt: Assignment.OPEN,
    });
    if (existing) {
      stats.skipped += 1;
      log(`  = already recorded    ${d.name}`);
      continue;
    }

    const vehicle = await Vehicle.findById(d.vehicleId);
    if (!vehicle) {
      problems.push(`${d.name} points at vehicle ${d.vehicleId}, which no longer exists`);
      continue;
    }

    // Real evidence beats a guess.
    const firstTrip = await Trip.findOne({ driverId: d._id, vehicleId: d.vehicleId })
      .sort({ startedAt: 1 })
      .select('startedAt');

    const startedAt = firstTrip?.startedAt || d.updatedAt || d.createdAt || new Date();
    const backfilled = !firstTrip;
    if (firstTrip) stats.vehicleFromTrip += 1; else stats.vehicleGuessed += 1;
    stats.vehicleStints += 1;

    log(
      `  + ${d.name.padEnd(34)} ${vehicle.plateNumber.padEnd(12)} from ${startedAt
        .toISOString()
        .slice(0, 10)}  ${firstTrip ? '(first trip)' : '(no trips — inferred)'}`
    );

    if (!dryRun) {
      await Assignment.create({
        assetKind: 'vehicle',
        assetId: vehicle._id,
        driverId: d._id,
        startedAt,
        endedAt: Assignment.OPEN,
        managerId: d.managerId || vehicle.managerId || null,
        country: d.country || null,
        project: d.project || null,
        assetLabel: vehicle.plateNumber,
        driverName: d.name,
        backfilled,
        note: firstTrip ? 'backfilled from first trip in this vehicle' : 'backfilled from current assignment',
      });
      await Vehicle.updateOne({ _id: vehicle._id }, { $set: { assignedDriverId: d._id } });
    }
  }

  /* ── 3. Mobile stints ─────────────────────────────────────────────────── */
  section('3. Mobile custody (no trip evidence exists — all inferred)');

  for (const d of drivers) {
    const device = deviceByDriver.get(String(d._id));
    if (!device) continue;

    // Only meaningful for a device that exists in the DB — a would-be-new one (dry run)
    // has an unsaved _id that cannot match anything. Gating on isNew rather than on dryRun
    // keeps the preview honest: re-running a dry run after applying must report 0 to create.
    if (!device.isNew) {
      const existing = await Assignment.findOne({
        assetKind: 'mobile', assetId: device._id, endedAt: Assignment.OPEN,
      });
      if (existing) { stats.skipped += 1; continue; }
    }

    const startedAt = d.updatedAt || d.createdAt || new Date();
    stats.mobileStints += 1;
    log(`  + ${d.name.padEnd(34)} ${device.displayLabel().padEnd(28)} since at least ${startedAt.toISOString().slice(0, 10)}`);

    if (!dryRun) {
      await Assignment.create({
        assetKind: 'mobile',
        assetId: device._id,
        driverId: d._id,
        startedAt,
        endedAt: Assignment.OPEN,
        managerId: d.managerId || null,
        country: d.country || null,
        project: d.project || null,
        assetLabel: device.displayLabel(),
        driverName: d.name,
        backfilled: true,
        note: 'backfilled from the fields previously stored on the driver',
      });
      // Point the driver at the device too, so the Drivers screen shows the allocation.
      await User.updateOne({ _id: d._id }, { $set: { mobileDeviceId: device._id } });
    }
  }

  /* ── Summary ──────────────────────────────────────────────────────────── */
  section('Summary');
  log(`  devices     ${stats.devicesCreated} created, ${stats.devicesExisting} already existed`);
  log(`  vehicles    ${stats.vehicleStints} stints  (${stats.vehicleFromTrip} dated from a real trip, ${stats.vehicleGuessed} inferred)`);
  log(`  mobiles     ${stats.mobileStints} stints  (all inferred — phones leave no trace)`);
  log(`  skipped     ${stats.skipped} already recorded`);

  if (problems.length) {
    log(`\n⚠️  ${problems.length} thing(s) need a human decision — NOT guessed at:`);
    problems.forEach((p) => log(`     • ${p}`));
  }

  if (dryRun) {
    log('\nNothing was written. Re-run without --dry-run to apply.');
  } else {
    log('\n✅ Backfill applied. User.imei etc. are untouched — dropping them is a separate step.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\n❌ Backfill failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
