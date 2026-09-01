const mongoose = require('mongoose');

// SSDS collections live in the same MongoDB as the main JSAN tracking database.
// Uses the default mongoose connection established by config/db.js.

function getSsdsCollections() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB not connected yet — call connectDB() first');
  return {
    drivers: db.collection('drivers'),
    driverHistory: db.collection('driver_history'),
    dailyReports: db.collection('daily_reports'),
    driverMaps: db.collection('driver_maps'),
    timesheets: db.collection('timesheets'),
    settings: db.collection('settings'),
    cor: db.collection('cor_declarations'),
  };
}

module.exports = { getSsdsCollections };
