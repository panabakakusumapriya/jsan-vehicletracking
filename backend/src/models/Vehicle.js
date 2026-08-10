const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema(
  {
    plateNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },
    vid: { type: String, trim: true, default: null },
    model: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    active: { type: Boolean, default: true },
    comments: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// Drop stale unique index on vid if it exists (was removed from schema but may linger in DB)
Vehicle.collection.dropIndex('vid_1').catch(() => {});

module.exports = Vehicle;
