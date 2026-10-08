const mongoose = require('mongoose');
const Marker = require('../models/Marker');
const MarkerCategory = require('../models/MarkerCategory');
const Trip = require('../models/Trip');
const Vehicle = require('../models/Vehicle');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { dayRange, isValidTimeZone } = require('../utils/timezone');

/**
 * How far either side of a trip a marker still belongs to it. A driver stops to flag a spot, and
 * the stop is often what ends the trip (or comes just before the next one starts) — a marker
 * dropped two minutes after the engine's stop timer closed the trip is still about that drive.
 */
const TRIP_GRACE_MS = 30 * 60 * 1000;

/** Marker payload exactly as every client draws it — flat, category resolved. */
function toJSON(m) {
  const cat = m.categoryId && m.categoryId.name
    ? { id: String(m.categoryId._id), name: m.categoryId.name, color: m.categoryId.color }
    : null;
  return {
    id: String(m._id),
    lat: m.lat,
    lon: m.lon,
    category: cat,
    driverName: m.driverName,
    vehiclePlate: m.vehiclePlate,
    note: m.note,
    recordedAt: m.recordedAt,
    createdAt: m.createdAt,
    tripId: m.tripId ? String(m.tripId) : null,
  };
}

const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * The operational category set: three flag groups, ONE category per colour. A driver at
 * 50-80 km/h picks the colour with a single tap; the reasons each colour covers ride in
 * `description` and are shown under the name in the picker — no per-reason choosing, no
 * confusion. Admins edit the reason lists on the Markers page.
 */
const DEFAULT_CATEGORIES = [
  {
    name: 'Red Flag', color: '#ef4444', order: 1,
    description: 'Tunnel, Traffic Accident, By Mistake, Underpass Road, Stopped by Police, ' +
      'Stopped by a Person, Due to Toll, Funeral Procession, Due to the Presence of a Naked Person',
  },
  {
    name: 'Yellow Marker', color: '#fbbc04', order: 2,
    description: 'Military Base, Private Area, Private Road, Private Property',
  },
  {
    name: 'Blue Marker', color: '#4285f4', order: 3,
    description: 'Road Is Impassable, Low-Hanging Trees, Low-Hanging Cables',
  },
];

/** Every default set that ever shipped — recognised only to migrate an untouched DB off it. */
const OLD_PLACEHOLDER_NAMES = [
  // first placeholder seed
  'Accident on the road', 'Car crash', 'Tunnel', 'Pressed by mistake',
  'Closed road', 'Private property',
  // second (SV-style) seed
  'Private Road', 'Problematic Imagery', 'Projects', 'No SV Access', 'Car Charging',
  'Camera Technical Issue', 'Incident',
  'Prohibited Area (Private property, Government sights, etc)',
  'Raining / Snowing', 'Vehicle Maintenance', 'Others',
  // third (per-reason) seed, later collapsed into the three colour groups
  'Traffic Accident', 'By Mistake', 'Underpass Road', 'Stopped by Police',
  'Stopped by a Person', 'Due to Toll', 'Funeral Procession',
  'Due to the Presence of a Naked Person', 'Military Base', 'Private Area',
  'Private Property', 'Road Is Impassable', 'Low-Hanging Trees', 'Low-Hanging Cables',
];

/**
 * Idempotent startup seed so a fresh deploy has something in the driver's picker. An
 * admin-touched list is left strictly alone; the one exception is a DB still holding exactly
 * the original placeholder set with zero markers dropped — that is not an admin's work, it is
 * the old seed's, and it gets replaced by the operational set once.
 */
async function seedDefaultCategories() {
  try {
    const existing = await MarkerCategory.find().select('name');
    if (existing.length === 0) {
      await MarkerCategory.insertMany(DEFAULT_CATEGORIES);
      // eslint-disable-next-line no-console
      console.log('Seeded marker categories');
      return;
    }
    const names = existing.map((c) => c.name);
    const onlyPlaceholders = names.every((n) => OLD_PLACEHOLDER_NAMES.includes(n));
    if (onlyPlaceholders && (await Marker.countDocuments()) === 0) {
      await MarkerCategory.deleteMany({});
      await MarkerCategory.insertMany(DEFAULT_CATEGORIES);
      // eslint-disable-next-line no-console
      console.log('Replaced placeholder marker categories with the operational set');
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Marker category seed failed:', e.message);
  }
}

// GET /api/markers/categories  (any signed-in user — drivers need the picker)
exports.listCategories = asyncHandler(async (req, res) => {
  const cats = await MarkerCategory.find().sort({ order: 1, createdAt: 1 });
  // Drivers only see active ones: the picker must not offer a retired reason. Staff see all,
  // because the admin page needs to show (and reactivate) the inactive ones.
  const visible = req.user.role === 'user' ? cats.filter((c) => c.active) : cats;
  res.json({
    categories: visible.map((c) => ({
      id: String(c._id), name: c.name, color: c.color, description: c.description,
      active: c.active, order: c.order,
    })),
  });
});

// POST /api/markers/categories  (admin)
exports.createCategory = asyncHandler(async (req, res) => {
  const { name, color, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  if (!COLOR_RE.test(String(color || ''))) return res.status(400).json({ error: 'color must be a #rrggbb hex value' });
  const last = await MarkerCategory.findOne().sort({ order: -1 });
  const cat = await MarkerCategory.create({
    name: String(name).trim(),
    color: String(color).toLowerCase(),
    description: description ? String(description).trim().slice(0, 400) : null,
    order: last ? last.order + 1 : 1,
  });
  res.status(201).json({
    category: {
      id: String(cat._id), name: cat.name, color: cat.color, description: cat.description,
      active: cat.active, order: cat.order,
    },
  });
});

// PATCH /api/markers/categories/:id  (admin)
exports.updateCategory = asyncHandler(async (req, res) => {
  const cat = await MarkerCategory.findById(req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { name, color, description, active } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
    cat.name = String(name).trim();
  }
  if (color !== undefined) {
    if (!COLOR_RE.test(String(color))) return res.status(400).json({ error: 'color must be a #rrggbb hex value' });
    cat.color = String(color).toLowerCase();
  }
  if (description !== undefined) {
    cat.description = description ? String(description).trim().slice(0, 400) : null;
  }
  if (active !== undefined) cat.active = !!active;
  await cat.save();
  res.json({
    category: {
      id: String(cat._id), name: cat.name, color: cat.color, description: cat.description,
      active: cat.active, order: cat.order,
    },
  });
});

// DELETE /api/markers/categories/:id  (admin)
exports.deleteCategory = asyncHandler(async (req, res) => {
  const used = await Marker.countDocuments({ categoryId: req.params.id });
  if (used > 0) {
    // History must stay legible: a marker whose category vanished is a dot nobody can explain.
    return res.status(409).json({
      error: `${used} marker(s) use this category — deactivate it instead of deleting.`,
    });
  }
  await MarkerCategory.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

// POST /api/markers  (driver)
// Body: { lat, lon, categoryId, clientId?, recordedAt?, note? }
exports.create = asyncHandler(async (req, res) => {
  const { lat, lon, categoryId, clientId, recordedAt, note } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon are required numbers' });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'lat/lon out of range' });
  }

  // Offline-retry safety: the same clientId is the same press, never a second marker.
  if (clientId) {
    const dup = await Marker.findOne({ clientId }).populate('categoryId', 'name color');
    if (dup) return res.json({ marker: toJSON(dup), duplicate: true });
  }

  const cat = await MarkerCategory.findById(categoryId);
  if (!cat || !cat.active) return res.status(400).json({ error: 'Unknown or inactive marker category' });

  // Stamp who/what NOW — a marker is fixed history (same rule Trip applies to its timezone).
  let tripId = null;
  let vehiclePlate = null;
  const at = recordedAt && !Number.isNaN(Date.parse(recordedAt)) ? new Date(recordedAt) : new Date();
  // The trip running when the driver pressed the button (an offline drop uploads later, maybe in
  // the next trip); failing that, one that ended or started within the grace either side.
  // Between two trips, the nearer one wins: a flag dropped 4 minutes after one trip ended and 6
  // before the next started belongs to the one that just ended.
  const gap = (t) => {
    const s0 = t.startedAt.getTime();
    const e0 = t.endedAt ? t.endedAt.getTime() : Date.now();
    return at < s0 ? s0 - at : at > e0 ? at - e0 : 0;
  };
  const near = await Trip.find({
    driverId: req.user._id,
    startedAt: { $lte: new Date(at.getTime() + TRIP_GRACE_MS) },
    $or: [{ endedAt: null }, { endedAt: { $gte: new Date(at.getTime() - TRIP_GRACE_MS) } }],
  }).select('startedAt endedAt vehicleId');
  const trip = near.sort((a, b) => gap(a) - gap(b) || b.startedAt - a.startedAt)[0] || null;
  if (trip) tripId = trip._id;
  const vehicleId = (trip && trip.vehicleId) || req.user.vehicleId || null;
  if (vehicleId) {
    const v = await Vehicle.findById(vehicleId).select('plateNumber');
    if (v) vehiclePlate = v.plateNumber;
  }

  const marker = await Marker.create({
    driverId: req.user._id,
    tripId,
    categoryId: cat._id,
    lat,
    lon,
    note: note ? String(note).slice(0, 500) : null,
    driverName: req.user.name || null,
    vehiclePlate,
    clientId: clientId || undefined,
    recordedAt: at,
  });
  marker.categoryId = cat; // for toJSON without a re-query
  res.status(201).json({ marker: toJSON(marker) });
});

// GET /api/markers/mine  (driver)
exports.mine = asyncHandler(async (req, res) => {
  const markers = await Marker.find({ driverId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(500)
    .populate('categoryId', 'name color');
  res.json({ markers: markers.map(toJSON) });
});

// GET /api/markers?days=90                          (admin / manager / team_lead — scoped)
// GET /api/markers?tripId=<id>                      that trip's markers, for the trip maps
// GET /api/markers?driverId=<id>&date=YYYY-MM-DD&tz= one driver's markers on one local day
// GET /api/markers?days=365&bbox=w,s,e,n            markers inside a map extent (Coverage)
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);

  // A trip's markers: the ones stamped with it, plus any the same driver dropped while it ran or
  // within the grace either side. Stamping alone missed nearly all of them — drivers stop to
  // flag a spot, and the trip had often just ended, or the drop was uploaded after it closed.
  if (req.query.tripId) {
    if (!mongoose.isValidObjectId(req.query.tripId)) {
      return res.status(400).json({ error: 'invalid tripId' });
    }
    const trip = await Trip.findOne({ _id: req.query.tripId, ...scope }).select('driverId startedAt endedAt');
    if (!trip) return res.json({ markers: [] });
    const from = new Date(trip.startedAt.getTime() - TRIP_GRACE_MS);
    const to = new Date((trip.endedAt ? trip.endedAt.getTime() : Date.now()) + TRIP_GRACE_MS);
    const markers = await Marker.find({
      driverId: trip.driverId,
      $or: [{ tripId: trip._id }, { recordedAt: { $gte: from, $lte: to } }],
    })
      .sort({ recordedAt: 1 })
      .populate('categoryId', 'name color');
    return res.json({ markers: markers.map(toJSON) });
  }

  // One driver's day, in the zone the Trips page grouped that day in.
  if (req.query.driverId && req.query.date) {
    if (!mongoose.isValidObjectId(req.query.driverId)) {
      return res.status(400).json({ error: 'invalid driverId' });
    }
    let range;
    try {
      range = dayRange(String(req.query.date), isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC');
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const allowed = scope.driverId === undefined ||
      (scope.driverId.$in ? scope.driverId.$in.some((d) => String(d) === String(req.query.driverId)) : String(scope.driverId) === String(req.query.driverId));
    if (!allowed) return res.json({ markers: [] });
    const markers = await Marker.find({
      driverId: req.query.driverId,
      recordedAt: { $gte: range.from, $lt: range.to },
    })
      .sort({ recordedAt: 1 })
      .populate('categoryId', 'name color');
    return res.json({ markers: markers.map(toJSON) });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { ...scope, createdAt: { $gte: since } };
  // A map extent: the Coverage map asks for the markers on the ground it is showing.
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    where.lon = { $gte: bbox[0], $lte: bbox[2] };
    where.lat = { $gte: bbox[1], $lte: bbox[3] };
  }
  const markers = await Marker.find(where)
    .sort({ createdAt: -1 })
    .limit(5000)
    .populate('categoryId', 'name color');
  res.json({ markers: markers.map(toJSON), days });
});

// DELETE /api/markers/:id  (admin)
exports.remove = asyncHandler(async (req, res) => {
  const m = await Marker.findByIdAndDelete(req.params.id);
  if (!m) return res.status(404).json({ error: 'Marker not found' });
  res.json({ ok: true });
});

exports.seedDefaultCategories = seedDefaultCategories;
