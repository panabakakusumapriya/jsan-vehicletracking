/**
 * One-time backfill: turn every distinct free-text `User.project` string already in the
 * database into a real `Project` document, then point each user's new `projectId` at it.
 *
 *   node src/seed/backfillProjects.js --dry-run     preview; writes NOTHING
 *   node src/seed/backfillProjects.js                apply
 *
 * Safe to re-run: matches existing Project docs by exact name (case-sensitive) before
 * creating a new one, and only touches users whose projectId is still null.
 *
 * Not required for the app to work — new users are validated against real Project records
 * from day one regardless (see user.controller.js), and existing accounts stay editable with
 * projectId unset until you run this or assign one by hand. Run it whenever you want the
 * Projects tab pre-populated from what's already live instead of starting empty.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Project = require('../models/Project');

const dryRun = process.argv.includes('--dry-run');
const log = (...a) => console.log(...a);

(async () => {
  await connectDB();

  const users = await User.find({ projectId: null, project: { $ne: null } }).select('_id project');
  const distinct = Array.from(new Set(users.map((u) => u.project.trim()).filter(Boolean)));

  log(`${users.length} user(s) with a free-text project but no projectId.`);
  log(`${distinct.length} distinct project name(s) to ensure exist:`);
  distinct.forEach((name) => log(`  - ${name}`));

  if (dryRun) {
    log('\n--dry-run: nothing written.');
    await mongoose.disconnect();
    return;
  }

  const nameToId = new Map();
  for (const name of distinct) {
    let project = await Project.findOne({ name });
    if (!project) {
      project = await Project.create({ name });
      log(`created Project "${name}"`);
    }
    nameToId.set(name, project._id);
  }

  let updated = 0;
  for (const u of users) {
    const id = nameToId.get(u.project.trim());
    if (!id) continue;
    await User.updateOne({ _id: u._id }, { $set: { projectId: id } });
    updated += 1;
  }
  log(`\nDone — ${updated} user(s) linked to a Project.`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error('backfillProjects failed:', err);
  process.exit(1);
});
