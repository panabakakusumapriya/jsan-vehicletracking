require('dotenv').config();

const required = ['MONGODB_URI', 'JWT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(
    `\n❌ Missing required environment variables: ${missing.join(', ')}\n` +
      '   Copy backend/.env.example to backend/.env and fill in the values.\n'
  );
  process.exit(1);
}

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  MONGODB_URI: process.env.MONGODB_URI,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  CORS_ORIGIN: (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()),
  HEARTBEAT_INTERVAL_SECONDS: parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '10', 10),
  STALE_AFTER_SECONDS: parseInt(process.env.STALE_AFTER_SECONDS || '60', 10),
  SEED_ADMIN_NAME: process.env.SEED_ADMIN_NAME || 'Super Admin',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@jsan.local',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
};
