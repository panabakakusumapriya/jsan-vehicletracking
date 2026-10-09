/**
 * Make an existing admin account a superadmin — the one way the first superadmin comes to be.
 * After that, superadmins create and promote others from the panel's Users page.
 *
 *   node src/seed/makeSuperadmin.js someone@company.com
 *
 * Runs against whatever MONGODB_URI is in the environment (.env locally).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { connectDB } = require('../config/db');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('usage: node src/seed/makeSuperadmin.js <email>');
    process.exit(2);
  }
  await connectDB();
  const user = await User.findOne({ email });
  if (!user) {
    console.error('no account with that email');
    process.exit(1);
  }
  if (!['admin', 'superadmin'].includes(user.role)) {
    console.error(`${email} is a ${user.role}, not an admin — only admins are promoted`);
    process.exit(1);
  }
  if (user.role === 'superadmin') {
    console.log(`${email} is already a superadmin`);
  } else {
    user.role = 'superadmin';
    await user.save();
    console.log(`${user.name} <${email}> is now a superadmin`);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
