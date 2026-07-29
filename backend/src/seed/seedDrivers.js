/**
 * Seed a roster of real drivers onto one manager.
 *
 *   npm run seed:drivers -- --dry-run          preview, touches nothing
 *   npm run seed:drivers                       create the missing ones
 *   npm run seed:drivers -- --reset-passwords  also reset EXISTING accounts to the default
 *   npm run seed:drivers -- --manager=someone@example.com
 *   npm run seed:drivers -- --password=Other123
 *
 * Idempotent. Re-running creates nothing twice: accounts are matched on email, and an
 * existing driver only has their profile fields (phone / country / manager) topped up.
 * Passwords are deliberately NOT touched on re-run unless --reset-passwords is passed —
 * otherwise a routine re-seed would silently hand everyone's account back to the default
 * after they'd changed it.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');

const DEFAULT_PASSWORD = 'Jsan123';
const DEFAULT_MANAGER_EMAIL = 'manager@jsan.local';

// Phone numbers as supplied: leading digits are the country code. Kept in this raw shape so
// the roster stays easy to eyeball against the source list.
const ROSTER = [
  { name: 'Khow Kok Wei', phone: '65 98255730', email: 'khowkokwei2@gmail.com' },
  { name: 'Scott Alexander Broughton Davidson', phone: '61 482489513', email: 'scottabdavidson88@gmail.com' },
  { name: 'Yann Sofiane Bazin', phone: '33 780375393', email: 'bazin961@gmail.com' },
  { name: 'Derrick Leatitagaloa', phone: '61 416885716', email: 'derrickleatitagaloa07@gmail.com' },
  { name: 'Asim Ahmad Khan', phone: '61 447554130', email: 'asimahmad1453@gmail.com' },
  { name: 'Ali Azhar', phone: '61 424734871', email: 'm.aliazhar9899@gmail.com' },
  { name: 'Morgan Ruaan Miles', phone: '61 490478220', email: 'morganmilesy@gmail.com' },
  { name: 'Shekar Valluri', phone: '61 425415543', email: 'vallurishekar69@gmail.com' },
  { name: 'Arvinder Singh Bedi', phone: '61 433851900', email: 'arvinderbedi@hotmail.com' },
  { name: 'Abbas Ali', phone: '61 426 279 805', email: 'ali.ahmed194@gmail.com' },
  { name: 'Sofyane Moussaoui', phone: '61 405 790 311', email: 'Sofyane_M@outlook.fr' },
  { name: 'Chandi Harsimran Singh', phone: '61 415904434', email: 'hs83.aus@gmail.com' },
  { name: 'Joel Howells', phone: '61 493718815', email: 'joelhowells1202@gmail.com' },
];

// Country is inferred from the dialling code purely so the live map's country filter has
// something to work with. Nothing depends on it — correct it in the Drivers page if a
// driver actually operates somewhere other than where their mobile is registered.
const DIALLING_CODES = [
  { code: '61', country: 'Australia' },
  { code: '65', country: 'Singapore' },
  { code: '33', country: 'France' },
];

function normalisePhone(raw) {
  const digits = String(raw).replace(/[^\d]/g, '');
  return `+${digits}`;
}

function countryFor(raw) {
  const digits = String(raw).replace(/[^\d]/g, '');
  const hit = DIALLING_CODES.find((c) => digits.startsWith(c.code));
  return hit ? hit.country : null;
}

function arg(name, fallback = null) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const resetPasswords = process.argv.includes('--reset-passwords');
  const password = arg('password', DEFAULT_PASSWORD);
  const managerEmail = arg('manager', DEFAULT_MANAGER_EMAIL);

  await connectDB();

  const manager = await User.findOne({ email: managerEmail.toLowerCase(), role: 'manager' });
  if (!manager) {
    console.error(
      `\n❌ No manager found with email "${managerEmail}".\n` +
        '   Pass --manager=<email> to pick a different one. Nothing was written.\n'
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\n${dryRun ? 'DRY RUN — nothing will be written' : 'Seeding drivers'}`);
  console.log(`Manager : ${manager.name} <${manager.email}>  (${manager._id})`);
  console.log(`Password: ${password}${resetPasswords ? '  (existing accounts WILL be reset)' : ''}`);
  console.log('');

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of ROSTER) {
    const email = row.email.toLowerCase();
    const phone = normalisePhone(row.phone);
    const country = countryFor(row.phone);
    const existing = await User.findOne({ email });

    if (!existing) {
      if (!dryRun) {
        const user = new User({
          name: row.name,
          email,
          phone,
          country,
          role: 'user', // 'user' is the driver role
          managerId: manager._id,
          active: true,
        });
        await user.setPassword(password);
        await user.save();
      }
      created += 1;
      console.log(`  + create  ${row.name.padEnd(36)} ${phone.padEnd(14)} ${country ?? '—'}`);
      continue;
    }

    // Already there — top up the profile without disturbing anything else.
    const changes = [];
    if (existing.role !== 'user') changes.push(`role ${existing.role}->user`);
    if (String(existing.managerId) !== String(manager._id)) changes.push('manager');
    if (existing.phone !== phone) changes.push('phone');
    if (existing.country !== country) changes.push('country');
    if (resetPasswords) changes.push('password');

    if (!changes.length) {
      unchanged += 1;
      console.log(`  = skip    ${row.name.padEnd(36)} already up to date`);
      continue;
    }

    if (!dryRun) {
      existing.role = 'user';
      existing.managerId = manager._id;
      existing.phone = phone;
      existing.country = country;
      if (resetPasswords) await existing.setPassword(password);
      await existing.save();
    }
    updated += 1;
    console.log(`  ~ update  ${row.name.padEnd(36)} ${changes.join(', ')}`);
  }

  console.log(
    `\n${dryRun ? 'Would create' : 'Created'} ${created}, ${
      dryRun ? 'would update' : 'updated'
    } ${updated}, unchanged ${unchanged}.`
  );
  if (!dryRun && created) {
    console.log(`Drivers sign in on the mobile app with their email and "${password}".`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('\n❌ Seed failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
