/**
 * A three-month custody story you can walk a manager through, then delete.
 *
 *   npm run demo:custody            create the demo data
 *   npm run demo:custody -- --clean remove every trace of it
 *
 * Everything goes through the real service (assign / release / driver exit) rather than
 * inserting rows directly — what you see on screen is the system working, not a mock-up.
 *
 * Every record it creates is tagged so cleanup is exact and can never touch real data:
 *   drivers  email ends @jsan.demo
 *   vehicles plate starts DEMO-
 *   devices  IMEI starts DEMO
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const MobileDevice = require('../models/MobileDevice');
const Assignment = require('../models/Assignment');
const custody = require('../services/assetCustody');
const { monthRange } = require('../utils/timezone');

const DEMO_EMAIL = /@jsan\.demo$/;
const DEMO_PLATE = /^DEMO-/;
const DEMO_IMEI = /^DEMO/;

// Midnight UTC, deliberately. Handovers at midday are perfectly valid and the report handles
// them — a stint from 1 May midday covers 30.6 of May's 31 days, which is arithmetically
// right but reads like a glitch on a slide. Whole days keep the demo legible, and they also
// make the numbers auditable out loud: every holder's days for one asset sum to the month.
const D = (iso) => new Date(`${iso}T00:00:00.000Z`);
const line = (c = '─') => console.log(c.repeat(78));

async function clean() {
  const drivers = await User.find({ email: DEMO_EMAIL }).select('_id name');
  const vehicles = await Vehicle.find({ plateNumber: DEMO_PLATE }).select('_id');
  const devices = await MobileDevice.find({ imei: DEMO_IMEI }).select('_id');

  const assetIds = [...vehicles.map((v) => v._id), ...devices.map((d) => d._id)];
  const driverIds = drivers.map((d) => d._id);

  const a = await Assignment.deleteMany({
    $or: [{ driverId: { $in: driverIds } }, { assetId: { $in: assetIds } }],
  });
  const v = await Vehicle.deleteMany({ plateNumber: DEMO_PLATE });
  const m = await MobileDevice.deleteMany({ imei: DEMO_IMEI });
  const u = await User.deleteMany({ email: DEMO_EMAIL });

  console.log(
    `\n🧹 Removed ${u.deletedCount} demo drivers, ${v.deletedCount} vehicles, ` +
      `${m.deletedCount} devices, ${a.deletedCount} custody rows.`
  );
  console.log('   Your real data was matched by tag and never touched.');
}

async function build() {
  // Hang the demo off the existing manager so it shows up in a manager's scoped view too.
  const manager = await User.findOne({ role: 'manager' }).sort({ createdAt: 1 });
  const admin = await User.findOne({ role: 'admin' }).sort({ createdAt: 1 });
  if (!manager) throw new Error('No manager exists — run `npm run seed` first.');

  const mkDriver = async (name, email, country) => {
    let u = await User.findOne({ email });
    if (!u) {
      u = new User({ name, email, role: 'user', managerId: manager._id, country, active: true });
      await u.setPassword('Demo123');
      await u.save();
    }
    return u;
  };

  const ravi = await mkDriver('DEMO Ravi Kumar', 'ravi@jsan.demo', 'Australia');
  const wei = await mkDriver('DEMO Wei Lin', 'wei@jsan.demo', 'Singapore');

  const mkVehicle = async (plate, model) =>
    (await Vehicle.findOne({ plateNumber: plate })) ||
    Vehicle.create({ plateNumber: plate, model, managerId: manager._id });

  const truck = await mkVehicle('DEMO-T100', 'Hino 300 truck');
  const van = await mkVehicle('DEMO-V200', 'Toyota HiAce van');

  const mkDevice = async (imei, model, label) =>
    (await MobileDevice.findOne({ imei })) ||
    MobileDevice.create({ imei, phoneModel: model, label, managerId: manager._id, status: 'in_stock' });

  const pixel = await mkDevice('DEMO000000001', 'Pixel 7a', 'DEMO phone A');
  const galaxy = await mkDevice('DEMO000000002', 'Galaxy A15', 'DEMO phone B');

  const step = async (when, what, fn) => {
    await fn();
    console.log(`  ${when}  ${what}`);
  };
  const give = (assetKind, asset, driver, when, note) =>
    custody.assign({
      assetKind,
      assetId: asset._id,
      driverId: driver._id,
      startedAt: D(when),
      note,
      actor: admin,
    });
  const takeBack = async (assetKind, asset, when, note) => {
    const open = await Assignment.findOne({ assetKind, assetId: asset._id, endedAt: Assignment.OPEN });
    if (open) await custody.release({ assignmentId: open._id, endedAt: D(when), note, actor: admin });
  };

  line();
  console.log('Building the story (each line is a real assign / return through the API layer)');
  line();

  console.log('\nMAY — everyone starts out');
  await step('01 May', 'Ravi  ← truck DEMO-T100', () => give('vehicle', truck, ravi, '2026-05-01', 'initial allocation'));
  await step('01 May', 'Ravi  ← phone Pixel 7a', () => give('mobile', pixel, ravi, '2026-05-01', 'initial allocation'));
  await step('01 May', 'Wei   ← van DEMO-V200', () => give('vehicle', van, wei, '2026-05-01', 'initial allocation'));
  await step('01 May', 'Wei   ← phone Galaxy A15', () => give('mobile', galaxy, wei, '2026-05-01', 'initial allocation'));

  console.log('\nJUNE — vehicles swap hands mid-month');
  await step('10 Jun', 'Wei   ← truck DEMO-T100   (from Ravi; Wei\'s van is auto-returned)',
    () => give('vehicle', truck, wei, '2026-06-10', 'route change'));
  await step('12 Jun', 'Ravi  ← van DEMO-V200     (2-day gap on purpose — shows as a gap)',
    () => give('vehicle', van, ravi, '2026-06-12', 'took over the van'));
  await step('20 Jun', 'Pixel 7a returned — screen damage, off to repair',
    async () => {
      await takeBack('mobile', pixel, '2026-06-20', 'screen damage → repair');
      await MobileDevice.updateOne({ _id: pixel._id }, { $set: { status: 'repair' } });
    });

  console.log('\nJULY — a phone moves between drivers, and one driver leaves');
  await step('05 Jul', 'Galaxy A15 returned by Wei',
    () => takeBack('mobile', galaxy, '2026-07-05', 'swapped for the repaired handset'));
  await step('06 Jul', 'Wei   ← phone Pixel 7a    (back from repair)',
    async () => {
      await MobileDevice.updateOne({ _id: pixel._id }, { $set: { status: 'in_stock' } });
      await give('mobile', pixel, wei, '2026-07-06', 'returned from repair');
    });
  await step('15 Jul', 'Ravi relocates to Singapore and picks up Galaxy A15',
    async () => {
      // The country is snapshotted onto the assignment, so July reads "Singapore" for this
      // stint while May and June still correctly read "Australia".
      await User.updateOne({ _id: ravi._id }, { $set: { country: 'Singapore' } });
      const fresh = await User.findById(ravi._id);
      await custody.assign({
        assetKind: 'mobile', assetId: galaxy._id, driverId: fresh._id,
        startedAt: D('2026-07-15'), note: 'relocated to Singapore', actor: admin,
      });
    });
  await step('20 Jul', 'Wei EXITS — truck + phone handed back automatically',
    async () => {
      await User.updateOne({ _id: wei._id }, { $set: { exitDate: D('2026-07-20'), active: false } });
      await custody.releaseAllForDriver({
        driverId: wei._id, endedAt: D('2026-07-20'), note: 'driver exit', actor: admin,
      });
    });

  /* ── Show what the report will say ── */
  const DAY = 86400000;
  for (const month of ['2026-05', '2026-06', '2026-07']) {
    const { from, to } = monthRange(month, 'UTC');
    const rows = await Assignment.find({
      ...Assignment.overlapFilter(from, to),
      driverId: { $in: [ravi._id, wei._id] },
    }).sort({ driverName: 1, assetKind: 1, startedAt: 1 });

    line();
    console.log(`${month}  —  ${rows.length} stint(s)`);
    line();
    const byDriver = new Map();
    for (const r of rows) {
      if (!byDriver.has(r.driverName)) byDriver.set(r.driverName, []);
      const days = Math.round(
        ((Math.min(r.endedAt.getTime(), to.getTime()) - Math.max(r.startedAt.getTime(), from.getTime())) / DAY) * 10
      ) / 10;
      const start = new Date(Math.max(r.startedAt.getTime(), from.getTime())).toISOString().slice(5, 10);
      const end = new Date(Math.min(r.endedAt.getTime(), to.getTime())).toISOString().slice(5, 10);
      byDriver.get(r.driverName).push(
        `${r.assetKind === 'vehicle' ? '🚚' : '📱'} ${String(r.assetLabel).padEnd(16)} ` +
          `${start}→${end}  ${String(days).padStart(4)}d  ${r.country || ''}`
      );
    }
    for (const [name, items] of byDriver) {
      console.log(`  ${name}`);
      items.forEach((i) => console.log(`      ${i}`));
    }
    if (!rows.length) console.log('  (nothing)');
  }

  line();
  console.log('HOW TO WALK THROUGH IT  —  Asset History page, timezone UTC');
  line();
  console.log('  1. MAY — the baseline. Each driver has one vehicle and one phone, all month.');
  console.log('');
  console.log('  2. JUNE — click back one month. The SAME truck now shows two holders:');
  console.log('     Ravi to the 10th, Wei from the 10th. In the old system last month\'s');
  console.log('     answer was simply gone; here both are on record.');
  console.log('     Sanity check you can say out loud: for DEMO-T100, 9d + 21d = 30 days.');
  console.log('     The holders\' days always add up to the month — nothing double-counted,');
  console.log('     nothing lost.');
  console.log('');
  console.log('  3. GAPS are visible, not hidden. Ravi is between vehicles on the 10th–11th,');
  console.log('     and has no phone after the 20th (his was in repair). 9d + 19d = 28d, so');
  console.log('     2 unassigned days — that is the bit a manager usually wants to spot.');
  console.log('');
  console.log('  4. JULY — one phone, three chapters: Ravi → repair → Wei. Open the Mobiles');
  console.log('     page and hit History on "DEMO phone A" to see its whole life in one list.');
  console.log('');
  console.log('  5. Ravi relocated to Singapore on 15 Jul. His Country column now reads');
  console.log('     Singapore, but his MAY and JUNE stints carry an amber "in Australia"');
  console.log('     tag — each row records where he was at the time, so moving country');
  console.log('     never rewrites the months already closed.');
  console.log('');
  console.log('  6. Wei exits on the 20th. His truck and phone are returned automatically,');
  console.log('     dated to the exit — so the assets are free to reassign, and his history');
  console.log('     survives him leaving. He shows as "exited" in the list.');
  console.log('');
  console.log('  7. Export CSV to hand the month to payroll or an auditor.');
  console.log('');
  console.log('Remove it all with:  npm run demo:custody -- --clean');
  line();
}

(async () => {
  await connectDB();
  if (process.argv.includes('--clean')) await clean();
  else await build();
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error('\n❌ Demo failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
