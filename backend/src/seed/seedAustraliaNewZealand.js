/**
 * Seed script: Australia & New Zealand drivers
 * Reads "Australia nd Newzeland.xlsx", creates/updates driver accounts,
 * assigns them to team lead Feroz Khan, and outputs a credentials Excel.
 *
 * Usage: node src/seed/seedAustraliaNewZealand.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const path = require('path');

const User = require('../models/User');
const env = require('../config/env');

// ── helpers ────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str || str === '') return null;
  // "18th Sep 2025", "21st Oct 2025", plain dates
  const cleaned = String(str)
    .replace(/(\d+)(st|nd|rd|th)/i, '$1')
    .trim();
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

/** Generate a readable random password: Word + 4 digits + symbol */
function generatePassword(name) {
  const first = (name || 'Driver').split(' ')[0];
  const capped = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return `${capped}@${digits}`;
}

/** Country code → full name mapping for the two countries in this sheet */
const COUNTRY_NAMES = { AU: 'Australia', NZ: 'New Zealand' };

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // 1. Find Feroz Khan (team lead)
  const teamLead = await User.findOne({ email: 'fkhan@jsanconsulting.com', role: 'team_lead' });
  if (!teamLead) {
    console.error('❌ Team lead fkhan@jsanconsulting.com not found. Aborting.');
    process.exit(1);
  }
  console.log(`✅ Team lead found: ${teamLead.name} (${teamLead._id})`);

  // 2. Find Prasanna (manager — any admin/manager whose name includes "prasanna")
  const prasanna = await User.findOne({
    name: { $regex: /prasanna/i },
    role: { $in: ['admin', 'manager'] },
  });
  if (!prasanna) {
    console.error('❌ Manager "Prasanna" not found. Aborting.');
    process.exit(1);
  }
  console.log(`✅ Manager found: ${prasanna.name} (${prasanna._id})`);

  // 3. Parse the Excel file
  const xlsxPath = path.resolve(__dirname, '../../../Australia nd Newzeland.xlsx');
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  console.log(`📋 ${rows.length} rows found in spreadsheet`);

  const credentials = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const name = String(row['Driver Name'] || '').trim();
    const ctsMail = String(row['CTS Mail'] || '').trim().toLowerCase();
    const driverId = String(row['Driver ID'] || '').trim();
    const project = String(row['Project'] || '').trim();
    const scope = String(row['Scope'] || '').trim();
    const region = String(row['Region'] || '').trim();
    const countryCode = String(row['Country'] || '').trim();
    const country = COUNTRY_NAMES[countryCode] || countryCode;
    const drivingLocation = String(row['Driving Location'] || '').trim();
    const poc = String(row['POC'] || '').trim();
    const contact = String(row['Contact'] || '').trim();
    const personalMail = String(row['Personal Mail'] || '').trim();
    const driverAddress = String(row['Driver Address'] || '').trim();
    const driverStatus = String(row['Driver Status'] || '').trim();
    const joiningDate = parseDate(row['Joining Date']);
    const exitDate = parseDate(row['Exit Date']);
    const pricePerHour = row['Price/Hour'] ? Number(row['Price/Hour']) : null;
    const currency = String(row['Currency'] || '').trim();

    if (!name) { skipped++; continue; }

    // Use CTS mail as login email; fall back to generated if blank
    const email = ctsMail || `${name.toLowerCase().replace(/\s+/g, '.')}.au@jsan.local`;

    // Check if already exists (by email or driverId)
    let user = await User.findOne({ $or: [{ email }, ...(driverId ? [{ driverId }] : [])] });

    let plainPassword = null;

    if (user) {
      // Update existing driver with fresh data from sheet
      user.name = name;
      user.country = country;
      user.managerId = prasanna._id;
      user.teamLeadId = teamLead._id;
      user.driverId = driverId || user.driverId;
      user.project = project;
      user.scope = scope;
      user.region = region;
      user.drivingLocation = drivingLocation;
      user.poc = poc;
      user.contact = contact;
      user.personalMail = personalMail;
      user.driverAddress = driverAddress;
      user.ctsMail = ctsMail;
      user.driverStatus = driverStatus;
      user.joiningDate = joiningDate;
      user.exitDate = exitDate;
      user.pricePerHour = pricePerHour;
      user.currency = currency;
      user.active = driverStatus.toLowerCase() !== 'exit';
      await user.save();
      updated++;
      console.log(`  ↻ Updated: ${name} <${email}>`);
      plainPassword = '(existing — unchanged)';
    } else {
      // Create new driver
      plainPassword = generatePassword(name);
      user = new User({
        name,
        email,
        role: 'user',
        country,
        managerId: prasanna._id,
        teamLeadId: teamLead._id,
        driverId,
        project,
        scope,
        region,
        drivingLocation,
        poc,
        contact,
        personalMail,
        driverAddress,
        ctsMail,
        driverStatus,
        joiningDate,
        exitDate,
        pricePerHour,
        currency,
        active: driverStatus.toLowerCase() !== 'exit',
      });
      user.passwordHash = await bcrypt.hash(plainPassword, 10);
      await user.save();
      created++;
      console.log(`  ✚ Created: ${name} <${email}>`);
    }

    credentials.push({
      'Driver ID': driverId,
      'Driver Name': name,
      'Project': project,
      'Country': country,
      'Driving Location': drivingLocation,
      'Status': driverStatus,
      'Login Email': email,
      'Password': plainPassword,
      'CTS Mail': ctsMail,
      'Contact': contact,
      'Personal Mail': personalMail,
      'POC': poc,
      'Price/Hour': pricePerHour,
      'Currency': currency,
      'Manager': prasanna.name,
      'Team Lead': teamLead.name,
    });
  }

  console.log(`\n📊 Summary: ${created} created, ${updated} updated, ${skipped} skipped`);

  // 4. Write credentials Excel
  const outWb = XLSX.utils.book_new();
  const outWs = XLSX.utils.json_to_sheet(credentials);
  // Column widths
  outWs['!cols'] = [
    { wch: 10 }, { wch: 28 }, { wch: 30 }, { wch: 14 }, { wch: 16 },
    { wch: 10 }, { wch: 40 }, { wch: 18 }, { wch: 40 }, { wch: 18 },
    { wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(outWb, outWs, 'Driver Credentials');
  const outPath = path.resolve(__dirname, '../../../AU_NZ_Driver_Credentials.xlsx');
  XLSX.writeFile(outWb, outPath);
  console.log(`\n✅ Credentials saved to: ${outPath}`);

  await mongoose.disconnect();
  console.log('✅ Done.');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
