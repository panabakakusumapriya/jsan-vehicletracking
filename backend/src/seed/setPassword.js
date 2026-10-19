/**
 * Set an account's password from the command line — and, with it, sign that account out
 * everywhere. The save stamps User.passwordChangedAt, and an API that carries the
 * passwordChangeSignsOut feature (check GET /health) refuses every token issued before that
 * moment: every browser and phone on the old password has to sign in again with the new one.
 * Accounts other than this one are untouched.
 *
 *   node src/seed/setPassword.js someone@company.com 'NewPassword123'
 *   npm run password -- someone@company.com 'NewPassword123'
 *
 * Runs against whatever MONGODB_URI is in the environment (.env locally). The new password is a
 * command-line argument, so it lands in the shell history: clear that afterwards if it matters.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { connectDB } = require('../config/db');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const password = process.argv[3];
  if (!email || !password) {
    console.error("usage: node src/seed/setPassword.js <email> '<new password>'");
    process.exit(2);
  }
  await connectDB();
  const user = await User.findOne({ email });
  if (!user) {
    console.error('no account with that email');
    process.exit(1);
  }
  await user.setPassword(password);
  await user.save();
  console.log(`${user.name} <${email}> (${user.role}): password set`);
  console.log(`passwordChangedAt = ${user.passwordChangedAt.toISOString()}`);
  console.log('Every session that signed in before that moment is refused once the live API has the');
  console.log('passwordChangeSignsOut feature; until then old sessions last until their token expires.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
