const mongoose = require('mongoose');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const fileStore = require('../utils/fileStore');
const HotelBooking = require('../models/HotelBooking');
const { BOOKED_VIA, ROOM_TYPES, PAYMENT } = require('../models/HotelBooking');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const Assignment = require('../models/Assignment');

/**
 * Hotel bookings the office makes for drivers — see models/HotelBooking.js for what the record is
 * and why its dates are calendar days. Admin, manager and team lead only; each sees the drivers
 * they already see everywhere else (utils/scope.js).
 */

const FILE_BUCKET = 'hotelBookingFiles';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Confirmations arrive as a PDF from the booking site or a screenshot of it.
const FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Whole nights between two calendar days, or null if either is not a real date. */
function nightsBetween(checkIn, checkOut) {
  if (!DAY.test(checkIn || '') || !DAY.test(checkOut || '')) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** The drivers this user may book for: null = everyone (admin), else a Set of id strings. */
async function allowedDriverIds(user) {
  const scope = await accessibleDriverFilter(user);
  if (!scope.driverId) return null;
  if (scope.driverId.$in) return new Set(scope.driverId.$in.map(String));
  return new Set([String(scope.driverId)]);
}

async function assertDriverAccess(user, driverId) {
  const allowed = await allowedDriverIds(user);
  if (allowed && !allowed.has(String(driverId))) {
    const err = new Error('You do not have access to that driver');
    err.status = 403;
    throw err;
  }
}

/** Mongo filter limiting bookings to the drivers this user sees. */
async function bookingScope(user) {
  const allowed = await allowedDriverIds(user);
  return allowed ? { driverId: { $in: [...allowed].map((id) => new mongoose.Types.ObjectId(id)) } } : {};
}

/** Plates of the vehicles the driver holds right now, from the custody ledger. */
async function currentPlates(driver) {
  const open = await Assignment.find({
    driverId: driver._id,
    assetKind: 'vehicle',
    endedAt: { $gt: new Date() },
  })
    .select('assetId')
    .lean();
  const ids = open.map((r) => r.assetId);
  if (!ids.length && driver.vehicleId) ids.push(driver.vehicleId);
  if (!ids.length) return [];
  const vehicles = await Vehicle.find({ _id: { $in: ids } }).select('plateNumber').lean();
  return vehicles.map((v) => v.plateNumber).filter(Boolean);
}

/** The driver as the booking form should open with them. */
async function driverProfile(driverId) {
  const d = await User.findOne({ _id: driverId, role: 'user' })
    .select('name driverId phone workPhone contact email personalMail project region country drivingLocation currency perDiem projectIds vehicleId')
    .lean();
  if (!d) return null;
  const plates = await currentPlates(d);
  return {
    _id: String(d._id),
    name: d.name,
    driverCode: d.driverId || null,
    // The number a hotel can actually reach them on: the work phone they carry, then the
    // account's own, then the free-text contact field from the roster import.
    phone: d.workPhone || d.phone || d.contact || null,
    email: d.email || d.personalMail || null,
    project: d.project || null,
    region: d.region || d.drivingLocation || null,
    country: d.country || null,
    vehiclePlate: plates.join(', ') || null,
    currency: d.currency || null,
    perDiem: typeof d.perDiem === 'number' ? d.perDiem : null,
    projectIds: (d.projectIds || []).map(String),
  };
}

const str = (v, max = 300) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Turn a request body into the fields to write. `partial` = a PATCH, where absent keys mean
 * "leave alone"; a create requires the essentials.
 */
function readBody(body, partial) {
  const b = body || {};
  const out = {};

  if (b.driver !== undefined) {
    const d = b.driver || {};
    out.driver = {
      name: str(d.name, 120),
      driverCode: str(d.driverCode, 60),
      phone: str(d.phone, 60),
      email: str(d.email, 120),
      project: str(d.project, 120),
      region: str(d.region, 120),
      country: str(d.country, 60),
      vehiclePlate: str(d.vehiclePlate, 120),
    };
    if (!out.driver.name) throw badRequest("The driver's name is required");
  }

  if (b.hotel !== undefined) {
    const h = b.hotel || {};
    const lat = num(h.lat);
    const lon = num(h.lon);
    out.hotel = {
      hotelLocationId: mongoose.isValidObjectId(h.hotelLocationId) ? h.hotelLocationId : null,
      name: str(h.name, 200),
      address: str(h.address, 300),
      city: str(h.city, 120),
      phone: str(h.phone, 60),
      category: str(h.category, 60),
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
    };
    if (!out.hotel.name) throw badRequest("The hotel's name is required");
  }

  for (const k of ['checkIn', 'checkOut']) {
    if (b[k] !== undefined) {
      if (!DAY.test(String(b[k] || ''))) throw badRequest(`${k === 'checkIn' ? 'Check-in' : 'Check-out'} must be a date`);
      out[k] = String(b[k]);
    }
  }

  if (b.rooms !== undefined) {
    const r = num(b.rooms);
    if (!Number.isInteger(r) || r < 1 || r > 50) throw badRequest('Rooms must be a whole number from 1');
    out.rooms = r;
  }
  if (b.roomType !== undefined) {
    if (!ROOM_TYPES.includes(b.roomType)) throw badRequest('Unknown room type');
    out.roomType = b.roomType;
  }
  if (b.breakfastIncluded !== undefined) out.breakfastIncluded = Boolean(b.breakfastIncluded);
  if (b.bookingReference !== undefined) out.bookingReference = str(b.bookingReference, 120);
  if (b.bookedVia !== undefined) {
    if (!BOOKED_VIA.includes(b.bookedVia)) throw badRequest('Unknown booking channel');
    out.bookedVia = b.bookedVia;
  }
  if (b.totalCost !== undefined) {
    const c = num(b.totalCost);
    if (Number.isNaN(c) || (c !== null && c < 0)) throw badRequest('Total cost must be a number');
    out.totalCost = c;
  }
  if (b.currency !== undefined) out.currency = str(b.currency, 8);
  if (b.payment !== undefined) {
    if (!PAYMENT.includes(b.payment)) throw badRequest('Unknown payment method');
    out.payment = b.payment;
  }
  if (b.notes !== undefined) out.notes = str(b.notes, 2000);

  if (!partial) {
    if (!out.hotel) throw badRequest('Pick or enter the hotel');
    if (!out.checkIn || !out.checkOut) throw badRequest('Check-in and check-out dates are required');
  }
  return out;
}

/**
 * Other live bookings for the same driver that share a night with [checkIn, checkOut).
 * Check-out day is not a night, so a stay ending on the 3rd and one starting on the 3rd are fine.
 */
function overlaps(driverId, checkIn, checkOut, excludeId) {
  return HotelBooking.find({
    driverId,
    status: 'booked',
    checkIn: { $lt: checkOut },
    checkOut: { $gt: checkIn },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select('hotel.name checkIn checkOut nights')
    .lean();
}

/** Where a stay is on the calendar, as of `today` — the VIEWER's today, sent by the panel. */
function stayState(b, today) {
  if (b.status === 'cancelled') return 'cancelled';
  if (!today) return 'booked';
  if (today < b.checkIn) return 'upcoming';
  if (today < b.checkOut) return 'staying';
  return 'completed';
}

function shape(b, today) {
  return {
    ...b,
    _id: String(b._id),
    driverId: String(b.driverId),
    stayState: stayState(b, today),
    costPerNight:
      typeof b.totalCost === 'number' && b.nights > 0 ? Math.round((b.totalCost / b.nights) * 100) / 100 : null,
    attachments: (b.attachments || []).map((a) => ({
      _id: String(a._id),
      filename: a.filename,
      contentType: a.contentType,
      bytes: a.bytes,
      uploadedAt: a.uploadedAt,
    })),
  };
}

/** The list filter shared by the table and the CSV export. */
async function listFilter(req) {
  const q = req.query;
  const today = DAY.test(String(q.today || '')) ? String(q.today) : new Date().toISOString().slice(0, 10);
  const filter = { ...(await bookingScope(req.user)) };

  if (q.driverId && mongoose.isValidObjectId(q.driverId)) {
    await assertDriverAccess(req.user, q.driverId);
    filter.driverId = new mongoose.Types.ObjectId(String(q.driverId));
  }
  if (q.projectId && mongoose.isValidObjectId(q.projectId)) {
    filter.projectIds = new mongoose.Types.ObjectId(String(q.projectId));
  }

  switch (q.when) {
    case 'current':
      Object.assign(filter, { status: 'booked', checkIn: { $lte: today }, checkOut: { $gt: today } });
      break;
    case 'upcoming':
      Object.assign(filter, { status: 'booked', checkIn: { $gt: today } });
      break;
    case 'past':
      Object.assign(filter, { status: 'booked', checkOut: { $lte: today } });
      break;
    case 'cancelled':
      filter.status = 'cancelled';
      break;
    default:
      break;
  }

  const text = String(q.q || '').trim();
  if (text) {
    const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { 'driver.name': rx }, { 'driver.driverCode': rx }, { 'hotel.name': rx },
      { 'hotel.city': rx }, { bookingReference: rx },
    ];
  }
  return { filter, today, when: q.when };
}

// GET /api/hotels/drivers — everyone this user can book for, for the form's driver picker.
exports.drivers = asyncHandler(async (req, res) => {
  const allowed = await allowedDriverIds(req.user);
  const filter = { role: 'user', active: true };
  if (allowed) filter._id = { $in: [...allowed] };
  const drivers = await User.find(filter).select('name driverId project').sort({ name: 1 }).lean();
  res.json({
    drivers: drivers.map((d) => ({ _id: String(d._id), name: d.name, driverCode: d.driverId || null, project: d.project || null })),
  });
});

// GET /api/hotels/drivers/:id/profile — the driver's details, to prefill a booking.
exports.driverProfile = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Bad driver id' });
  await assertDriverAccess(req.user, req.params.id);
  const profile = await driverProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Driver not found' });
  res.json({ driver: profile });
});

// GET /api/hotels/bookings?when=current|upcoming|past|cancelled&driverId&projectId&q&today
exports.list = asyncHandler(async (req, res) => {
  const { filter, today, when } = await listFilter(req);
  // Soonest first for what is still ahead; most recent first for everything else.
  const sort = when === 'upcoming' || when === 'current' ? { checkIn: 1 } : { checkIn: -1 };
  const rows = await HotelBooking.find(filter).sort(sort).limit(1000).lean();
  res.json({ bookings: rows.map((b) => shape(b, today)), today });
});

// GET /api/hotels/bookings/export.csv — the same list, as a spreadsheet.
exports.exportCsv = asyncHandler(async (req, res) => {
  const { filter, today } = await listFilter(req);
  const rows = await HotelBooking.find(filter).sort({ checkIn: -1 }).limit(10000).lean();
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Driver', 'Driver ID', 'Phone', 'Email', 'Project', 'Vehicle', 'Hotel', 'Hotel address', 'City',
    'Check-in', 'Check-out', 'Nights', 'Rooms', 'Room type', 'Breakfast', 'Booked via', 'Reference',
    'Total cost', 'Currency', 'Cost per night', 'Payment', 'Status', 'Booked by', 'Booked on', 'Notes',
  ];
  const body = rows.map((raw) => {
    const b = shape(raw, today);
    return [
      b.driver?.name, b.driver?.driverCode, b.driver?.phone, b.driver?.email, b.driver?.project,
      b.driver?.vehiclePlate, b.hotel?.name, b.hotel?.address, b.hotel?.city,
      b.checkIn, b.checkOut, b.nights, b.rooms, b.roomType, b.breakfastIncluded ? 'yes' : 'no',
      b.bookedVia, b.bookingReference, b.totalCost, b.currency, b.costPerNight, b.payment,
      b.stayState, b.bookedByName, b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : '',
      b.notes,
    ].map(esc).join(',');
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hotel-bookings-${today}.csv"`);
  res.send([header.join(','), ...body].join('\n'));
});

// POST /api/hotels/bookings
exports.create = asyncHandler(async (req, res) => {
  const driverId = req.body?.driverId;
  if (!mongoose.isValidObjectId(driverId)) return res.status(400).json({ error: 'Pick the driver' });
  await assertDriverAccess(req.user, driverId);
  const profile = await driverProfile(driverId);
  if (!profile) return res.status(404).json({ error: 'Driver not found' });

  let fields;
  try {
    fields = readBody(req.body, false);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const nights = nightsBetween(fields.checkIn, fields.checkOut);
  if (!nights || nights < 1) return res.status(400).json({ error: 'Check-out must be after check-in' });

  if (!req.body.force) {
    const clash = await overlaps(driverId, fields.checkIn, fields.checkOut);
    if (clash.length) {
      return res.status(409).json({ error: 'This driver already has a stay booked on some of these nights', code: 'OVERLAP', conflicts: clash });
    }
  }

  const booking = await HotelBooking.create({
    ...fields,
    driverId,
    // The form's snapshot if it sent one (edited contact details), else the system's.
    driver: fields.driver || {
      name: profile.name, driverCode: profile.driverCode, phone: profile.phone, email: profile.email,
      project: profile.project, region: profile.region, country: profile.country, vehiclePlate: profile.vehiclePlate,
    },
    projectIds: profile.projectIds,
    nights,
    currency: fields.currency ?? profile.currency,
    bookedBy: req.user._id,
    bookedByName: req.user.name,
  });
  res.status(201).json({ booking: shape(booking.toObject(), req.body.today) });
});

async function loadForUser(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw badRequest('Bad booking id');
  const booking = await HotelBooking.findById(req.params.id);
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  await assertDriverAccess(req.user, booking.driverId);
  return booking;
}

// PATCH /api/hotels/bookings/:id — edit, cancel (status: 'cancelled') or reinstate ('booked').
exports.update = asyncHandler(async (req, res) => {
  const booking = await loadForUser(req);
  let fields;
  try {
    fields = readBody(req.body, true);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }

  const checkIn = fields.checkIn ?? booking.checkIn;
  const checkOut = fields.checkOut ?? booking.checkOut;
  const nights = nightsBetween(checkIn, checkOut);
  if (!nights || nights < 1) return res.status(400).json({ error: 'Check-out must be after check-in' });

  const status = req.body.status;
  if (status !== undefined && !['booked', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status' });
  }
  const willBeLive = (status ?? booking.status) === 'booked';
  if (willBeLive && !req.body.force) {
    const clash = await overlaps(booking.driverId, checkIn, checkOut, booking._id);
    if (clash.length) {
      return res.status(409).json({ error: 'This driver already has a stay booked on some of these nights', code: 'OVERLAP', conflicts: clash });
    }
  }

  Object.assign(booking, fields, { nights });
  if (status === 'cancelled' && booking.status !== 'cancelled') {
    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.cancelledByName = req.user.name;
  } else if (status === 'booked' && booking.status === 'cancelled') {
    booking.status = 'booked';
    booking.cancelledAt = null;
    booking.cancelledByName = null;
  }
  await booking.save();
  res.json({ booking: shape(booking.toObject(), req.body.today) });
});

/**
 * POST /api/hotels/bookings/:id/attachments — the booking confirmation, as the raw request body.
 *
 * Raw rather than multipart, streamed straight into GridFS, the same way network imports are:
 * the container's disk does not survive a redeploy, and a confirmation is exactly the kind of
 * thing someone needs months later when the hotel disputes the bill.
 */
exports.uploadAttachment = asyncHandler(async (req, res) => {
  const booking = await loadForUser(req);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!FILE_TYPES.has(type)) {
    return res.status(415).json({ error: 'Attach a PDF or an image (PNG, JPG, WebP, HEIC)' });
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_FILE_BYTES) {
    return res.status(413).json({ error: `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
  }
  if ((booking.attachments || []).length >= 10) {
    return res.status(400).json({ error: 'A booking can hold at most 10 files' });
  }
  let filename = 'confirmation';
  try {
    filename = decodeURIComponent(String(req.headers['x-file-name'] || 'confirmation')).slice(0, 200);
  } catch { /* keep the default */ }

  const stored = await fileStore.putStream(req, {
    filename,
    bucketName: FILE_BUCKET,
    contentType: type,
    metadata: { bookingId: String(booking._id) },
  });
  // Content-Length can be absent (chunked), so the real size is checked after the fact too.
  if (!stored.bytes || stored.bytes > MAX_FILE_BYTES) {
    await fileStore.remove(stored.id, FILE_BUCKET);
    return res.status(stored.bytes ? 413 : 400).json({ error: stored.bytes ? 'File is too large' : 'The file was empty' });
  }

  booking.attachments.push({
    fileId: stored.id, filename, contentType: type, bytes: stored.bytes, uploadedBy: req.user._id,
  });
  await booking.save();
  res.status(201).json({ booking: shape(booking.toObject(), req.query.today) });
});

// GET /api/hotels/bookings/:id/attachments/:attId — download one file.
exports.downloadAttachment = asyncHandler(async (req, res) => {
  const booking = await loadForUser(req);
  const att = booking.attachments.id(req.params.attId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${att.filename.replace(/["\r\n]/g, '')}"`);
  const stream = fileStore.openDownload(att.fileId, FILE_BUCKET);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'File is missing from storage' });
    else res.end();
  });
  stream.pipe(res);
});

// DELETE /api/hotels/bookings/:id/attachments/:attId
exports.deleteAttachment = asyncHandler(async (req, res) => {
  const booking = await loadForUser(req);
  const att = booking.attachments.id(req.params.attId);
  if (!att) return res.status(404).json({ error: 'File not found' });
  await fileStore.remove(att.fileId, FILE_BUCKET);
  att.deleteOne();
  await booking.save();
  res.json({ booking: shape(booking.toObject(), req.query.today) });
});

module.exports.nightsBetween = nightsBetween;
