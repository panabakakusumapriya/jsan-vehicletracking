const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('connected', () => console.log('✅ MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));

  const uri = 'mongodb://mongo:CEeeazekNTlmTvkOSOPVIDCCMdQzxivQ@altaria.proxy.rlwy.net:31582/jsan_tracking?authSource=admin';
  await mongoose.connect(uri, {
    autoIndex: true,
    serverSelectionTimeoutMS: 10000,
  });
  return mongoose.connection;
}

module.exports = { connectDB };
