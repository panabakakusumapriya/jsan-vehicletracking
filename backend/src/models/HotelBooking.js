const mongoose = require('mongoose');

/**
 * A hotel stay booked for a driver by the office.
 *
 * The Hotels page finds somewhere to stay and hands off to Booking.com (or the phone) for the
 * booking itself; nothing came back, so nobody could answer "where is Ali sleeping tonight, for how
 * many nights, and what did it cost". This is that record. Admin-side only — drivers never see it.
 *
 * Dates are CALENDAR days ('YYYY-MM-DD'), not instants. A check-in is "the 3rd", wherever the
 * person reading it happens to be; stored as a timestamp it would slide a day for anyone viewing
 * from the other side of the date line, and Australia versus India is exactly this fleet.
 *
 * Driver and hotel are SNAPSHOTS as well as references. A booking from March must still say which
 * phone number and which hotel it was made with after the driver changes number or the dataset is
 * re-imported — the same reasoning as the Assignment ledger's snapshots.
 */

const BOOKED_VIA = ['booking_com', 'direct', 'phone', 'other'];
const ROOM_TYPES = ['single', 'double', 'twin', 'family', 'other'];
const PAYMENT = ['company_card', 'driver_claims', 'pay_at_hotel'];
const STATUS = ['booked', 'cancelled'];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const attachmentSchema = new mongoose.Schema(
  {
    // GridFS id in the hotelBookingFiles bucket — see utils/fileStore.js.
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, default: 'application/octet-stream' },
    bytes: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: true }
);

const hotelBookingSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The driver as they were when booked — editable in the form, since the booking may have been
    // made under a different number than the one on file.
    driver: {
      name: { type: String, required: true, trim: true },
      driverCode: { type: String, trim: true, default: null },
      phone: { type: String, trim: true, default: null },
      email: { type: String, trim: true, default: null },
      project: { type: String, trim: true, default: null },
      region: { type: String, trim: true, default: null },
      country: { type: String, trim: true, default: null },
      vehiclePlate: { type: String, trim: true, default: null },
    },
    // For filtering by project without trusting the free-text snapshot above.
    projectIds: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },

    hotel: {
      // The imported directory row it came from, when it came from one. Null for a place booked
      // that is not in the dataset.
      hotelLocationId: { type: mongoose.Schema.Types.ObjectId, ref: 'HotelLocation', default: null },
      name: { type: String, required: true, trim: true },
      address: { type: String, trim: true, default: null },
      city: { type: String, trim: true, default: null },
      phone: { type: String, trim: true, default: null },
      category: { type: String, trim: true, default: null },
      lat: { type: Number, default: null },
      lon: { type: Number, default: null },
    },

    checkIn: { type: String, required: true, match: DAY },
    checkOut: { type: String, required: true, match: DAY },
    // Derived from the two dates on every save, never trusted from the client.
    nights: { type: Number, required: true, min: 1 },

    rooms: { type: Number, default: 1, min: 1 },
    roomType: { type: String, enum: ROOM_TYPES, default: 'single' },
    breakfastIncluded: { type: Boolean, default: false },

    bookingReference: { type: String, trim: true, default: null },
    bookedVia: { type: String, enum: BOOKED_VIA, default: 'booking_com' },

    totalCost: { type: Number, default: null, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: null },
    payment: { type: String, enum: PAYMENT, default: 'company_card' },

    notes: { type: String, trim: true, default: null },

    // Only the two states a person decides. "Upcoming / staying now / completed" follow from the
    // dates, so they are computed rather than stored — a stored copy would need someone to move it.
    status: { type: String, enum: STATUS, default: 'booked', index: true },
    cancelledAt: { type: Date, default: null },
    cancelledByName: { type: String, default: null },

    attachments: { type: [attachmentSchema], default: [] },

    bookedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    bookedByName: { type: String, default: null },
  },
  { timestamps: true }
);

// One driver's stays in date order, and the overlap check on save.
hotelBookingSchema.index({ driverId: 1, checkIn: 1 });
// Current / upcoming / past views across the fleet.
hotelBookingSchema.index({ checkIn: 1, checkOut: 1 });

module.exports = mongoose.model('HotelBooking', hotelBookingSchema);
module.exports.BOOKED_VIA = BOOKED_VIA;
module.exports.ROOM_TYPES = ROOM_TYPES;
module.exports.PAYMENT = PAYMENT;
