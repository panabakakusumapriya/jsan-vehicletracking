const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('connected', () => console.log('✅ MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected'));

  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: true,
    serverSelectionTimeoutMS: 10000,
  });
  return mongoose.connection;
}

module.exports = { connectDB };
