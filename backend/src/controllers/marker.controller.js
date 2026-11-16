const mongoose = require('mongoose');
const Marker = require('../models/Marker');
const MarkerCategory = require('../models/MarkerCategory');
const Trip = require('../models/Trip');
const Vehicle = require('../models/Vehicle');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { dayRange, isValidTimeZone } = require('../utils/timezone');
const s3 = require('../config/s3');

/**
 * Marker photos. At most MAX_PHOTOS per drop, JPEG only (the phone re-encodes every picture to a
 * ~1600 px JPEG before it queues it, so a photo is a few hundred KB, not a 6 MB camera original).
 * Each lives at markers/<driverId>/<clientId>/<n>.jpg: the same drop asks for the same keys every
 * time, so a retried upload overwrites itself instead of leaving orphans, and the driver and drop in
 * the key are what lets the server accept a key from the phone without trusting it.
 */
const MAX_PHOTOS = 3;
const PHOTO_TYPE = 'image/jpeg';
const PHOTO_LINK_SECONDS = 6 * 60 * 60;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
const photoPrefix = (driverId, clientId) => `markers/${driverId}/${clientId}/`;
const photoKey = (driverId, clientId, n) => `${photoPrefix(driverId, clientId)}${n}.jpg`;

/** The photos a drop may carry: only keys this driver was handed for this very drop. */
function cleanPhotos(user, clientId, photos) {
  if (!Array.isArray(photos) || !photos.length || !clientId) return [];
  const prefix = photoPrefix(user._id, clientId);
  const seen = new Set();
  const out = [];
  for (const ph of photos.slice(0, MAX_PHOTOS)) {
    const key = ph && typeof ph.key === 'string' ? ph.key : '';
    if (!key.startsWith(prefix) || !/^\d\.jpg$/.test(key.slice(prefix.length)) || seen.has(key)) continue;
    seen.add(key);
    const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    out.push({ key, width: num(ph.width), height: num(ph.height), bytes: num(ph.bytes) });
  }
  return out;
}

/**
 * Signed links to view the photos, added to markers already shaped by toJSON. The bucket is
 * private and an <img> cannot send our token, so every read hands out links that work for six hours
 * (PHOTO_LINK_SECONDS) — a panel left open all morning keeps showing them.
 * Signing is local arithmetic (no request to the bucket), so a page of markers costs nothing extra.
 */
async function withPhotoUrls(list) {
  if (!s3.isS3Configured()) return list;
  await Promise.all(list.map(async (m) => {
    if (!m.photos || !m.photos.length) return;
    m.photos = await Promise.all(m.photos.map(async (ph) => ({ ...ph, url: await s3.presignGet(ph.key, PHOTO_LINK_SECONDS) })));
  }));
  return list;
}

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
    reason: m.reason || null,
    note: m.note,
    // Keys and sizes; the links to view them are added by withPhotoUrls on the way out.
    photos: (m.photos || []).map((ph) => ({ key: ph.key, width: ph.width ?? null, height: ph.height ?? null })),
    recordedAt: m.recordedAt,
    createdAt: m.createdAt,
    tripId: m.tripId ? String(m.tripId) : null,
    // The phone's own id for the drop: lets it match a marker it removed before the upload landed.
    clientId: m.clientId || null,
  };
}

/** Markers still on the map — a driver can take their own off (removeMine); history keeps them. */
const LIVE = { removedAt: null };

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
/**
 * One drop, as the phone sent it. Returns { marker } (status 201, or 200 for a duplicate) or
 * { error, status }. Shared by POST /api/markers and POST /api/markers/batch, so a marker uploaded
 * in a batch is stamped exactly as one sent alone.
 */
async function createOne(user, body, ctx = null) {
  const { lat, lon, categoryId, clientId, recordedAt, note, reason } = body || {};
  const photos = cleanPhotos(user, clientId, body && body.photos);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { status: 400, error: 'lat and lon are required numbers' };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { status: 400, error: 'lat/lon out of range' };

  // Offline-retry safety: the same clientId is the same press, never a second marker.
  // In a batch (ctx) the duplicates were looked up together, and categories and plates are
  // remembered across its markers: 50 drops were 250 round trips, one after another.
  if (clientId) {
    const dup = ctx
      ? ctx.dups.get(String(clientId))
      : await Marker.findOne({ clientId }).populate('categoryId', 'name color');
    if (dup) {
      // The same drop again. If an earlier copy arrived without its photos or reason (an upload cut
      // short), this one completes it; otherwise it is answered as it stands.
      if ((photos.length && !(dup.photos && dup.photos.length)) || (reason && !dup.reason)) {
        if (photos.length && !(dup.photos && dup.photos.length)) dup.photos = photos;
        if (reason && !dup.reason) dup.reason = String(reason).trim().slice(0, 200);
        await dup.save();
      }
      return { status: 200, marker: toJSON(dup), duplicate: true };
    }
  }

  const catKey = String(categoryId);
  let cat = ctx && ctx.cats.get(catKey);
  if (cat === undefined || cat === null) {
    cat = await MarkerCategory.findById(categoryId);
    if (ctx) ctx.cats.set(catKey, cat);
  }
  if (!cat || !cat.active) return { status: 400, error: 'Unknown or inactive marker category' };

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
    driverId: user._id,
    // Bounded below as well: without it this walked every trip the driver ever made. No trip
    // runs for three days (they are force-closed long before).
    startedAt: { $lte: new Date(at.getTime() + TRIP_GRACE_MS), $gte: new Date(at.getTime() - 3 * 86400000) },
    $or: [{ endedAt: null }, { endedAt: { $gte: new Date(at.getTime() - TRIP_GRACE_MS) } }],
  }).select('startedAt endedAt vehicleId');
  const trip = near.sort((a, b) => gap(a) - gap(b) || b.startedAt - a.startedAt)[0] || null;
  if (trip) tripId = trip._id;
  const vehicleId = (trip && trip.vehicleId) || user.vehicleId || null;
  if (vehicleId) {
    const vKey = String(vehicleId);
    if (ctx && ctx.plates.has(vKey)) vehiclePlate = ctx.plates.get(vKey);
    else {
      const v = await Vehicle.findById(vehicleId).select('plateNumber');
      if (v) vehiclePlate = v.plateNumber;
      if (ctx) ctx.plates.set(vKey, vehiclePlate);
    }
  }

  const marker = await Marker.create({
    driverId: user._id,
    tripId,
    categoryId: cat._id,
    lat,
    lon,
    reason: reason && String(reason).trim() ? String(reason).trim().slice(0, 200) : null,
    note: note && String(note).trim() ? String(note).trim().slice(0, 500) : null,
    photos: photos.length ? photos : undefined,
    driverName: user.name || null,
    vehiclePlate,
    clientId: clientId || undefined,
    recordedAt: at,
  });
  marker.categoryId = cat; // for toJSON without a re-query
  // The same press twice in one batch is still one marker.
  if (ctx && clientId) ctx.dups.set(String(clientId), marker);
  return { status: 201, marker: toJSON(marker) };
}

exports.create = asyncHandler(async (req, res) => {
  const r = await createOne(req.user, req.body);
  if (r.error) return res.status(r.status).json({ error: r.error });
  await withPhotoUrls([r.marker]);
  return res.status(r.status).json(r.duplicate ? { marker: r.marker, duplicate: true } : { marker: r.marker });
});

/**
 * POST /api/markers/photo-uploads  { clientId, count }   (driver)
 *
 * Signed links for the phone to put a drop's photos straight into the bucket, one per photo, valid
 * 15 minutes. The phone asks just before it uploads (from its outbox, maybe hours after the drop),
 * PUTs each JPEG with Content-Type image/jpeg, and then sends the marker with the keys. Asking again
 * for the same drop returns the same keys, so a retry overwrites rather than duplicates.
 * 503 while the server has no bucket configured: the phone keeps the drop queued until it has.
 */
exports.photoUploads = asyncHandler(async (req, res) => {
  const { clientId, count } = req.body || {};
  if (!CLIENT_ID_RE.test(String(clientId || ''))) return res.status(400).json({ error: 'clientId is required' });
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1 || n > MAX_PHOTOS) {
    return res.status(400).json({ error: `count must be 1-${MAX_PHOTOS}` });
  }
  if (!s3.isS3Configured()) return res.status(503).json({ error: 'Photo storage is not configured on the server' });
  const uploads = [];
  for (let i = 0; i < n; i += 1) {
    const key = photoKey(req.user._id, clientId, i);
    uploads.push({ key, url: await s3.presignPut(key, PHOTO_TYPE), contentType: PHOTO_TYPE });
  }
  res.json({ uploads, maxPhotos: MAX_PHOTOS });
});

/**
 * POST /api/markers/batch  { markers: [{ lat, lon, categoryId, clientId, recordedAt, note? }, …] }
 *
 * The phone saves a drop on itself first and uploads its outbox in the background, several at a
 * time — so the driver never waits on the network to see a drop land. Each entry is handled as
 * POST /api/markers handles one (a clientId already in is answered, not doubled); one bad entry
 * does not fail the rest. Answers { results: [{ clientId, marker } | { clientId, error, permanent }] }.
 */
const MAX_BATCH = 100;
exports.createBatch = asyncHandler(async (req, res) => {
  const list = Array.isArray(req.body && req.body.markers) ? req.body.markers.slice(0, MAX_BATCH) : null;
  if (!list) return res.status(400).json({ error: 'markers must be an array' });
  const results = [];
  const ids = list.map((m) => m && m.clientId).filter(Boolean).map(String);
  const ctx = { dups: new Map(), cats: new Map(), plates: new Map() };
  if (ids.length) {
    for (const d of await Marker.find({ clientId: { $in: ids } }).populate('categoryId', 'name color')) {
      ctx.dups.set(String(d.clientId), d);
    }
  }
  for (const m of list) {
    try {
      const r = await createOne(req.user, m, ctx);
      results.push(r.error
        ? { clientId: m && m.clientId, error: r.error, permanent: r.status === 400 }
        : { clientId: m && m.clientId, marker: r.marker });
    } catch (e) {
      results.push({ clientId: m && m.clientId, error: e.message, permanent: false });
    }
  }
  await withPhotoUrls(results.filter((r) => r.marker).map((r) => r.marker));
  res.json({ results });
});

// GET /api/markers/mine  (driver)
exports.mine = asyncHandler(async (req, res) => {
  const markers = await Marker.find({ driverId: req.user._id, ...LIVE })
    .sort({ createdAt: -1 })
    .populate('categoryId', 'name color');
  res.json({ markers: await withPhotoUrls(markers.map(toJSON)) });
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
      ...LIVE,
      $or: [{ tripId: trip._id }, { recordedAt: { $gte: from, $lte: to } }],
    })
      .sort({ recordedAt: 1 })
      .populate('categoryId', 'name color');
    return res.json({ markers: await withPhotoUrls(markers.map(toJSON)) });
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
      ...LIVE,
      recordedAt: { $gte: range.from, $lt: range.to },
    })
      .sort({ recordedAt: 1 })
      .populate('categoryId', 'name color');
    return res.json({ markers: await withPhotoUrls(markers.map(toJSON)) });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { ...scope, ...LIVE, createdAt: { $gte: since } };
  // A map extent: the Coverage map asks for the markers on the ground it is showing.
  const bbox = String(req.query.bbox || '').split(',').map(Number);
  if (bbox.length === 4 && bbox.every(Number.isFinite)) {
    where.lon = { $gte: bbox[0], $lte: bbox[2] };
    where.lat = { $gte: bbox[1], $lte: bbox[3] };
  }
  const markers = await Marker.find(where)
    .sort({ createdAt: -1 })
    .populate('categoryId', 'name color');
  res.json({ markers: await withPhotoUrls(markers.map(toJSON)), days });
});

/**
 * DELETE /api/markers/mine/:key  (driver) — take one of your own markers off the map.
 *
 * `key` is the marker's id, or the clientId the phone made when it was dropped: a marker removed
 * while it was still waiting to upload is only known to the phone by that. Idempotent and quiet:
 * removing one that is already gone, never arrived, or is not yours answers { removed: false } —
 * the phone's removal outbox can retry freely, and nothing about other drivers' markers leaks.
 *
 * A soft removal (removedAt / removedBy): the record and who took it off stay, for the office.
 */
exports.removeMine = asyncHandler(async (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key || key.length > 100) return res.status(400).json({ error: 'invalid marker' });
  const or = [{ clientId: key }];
  if (/^[a-f\d]{24}$/i.test(key)) or.push({ _id: key });
  const m = await Marker.findOne({ driverId: req.user._id, $or: or });
  if (!m) return res.json({ ok: true, removed: false });
  if (!m.removedAt) {
    m.removedAt = new Date();
    m.removedBy = req.user._id;
    await m.save();
  }
  return res.json({ ok: true, removed: true, id: String(m._id) });
});

// DELETE /api/markers/:id  (admin)
exports.remove = asyncHandler(async (req, res) => {
  const m = await Marker.findByIdAndDelete(req.params.id);
  if (!m) return res.status(404).json({ error: 'Marker not found' });
  res.json({ ok: true });
});

exports.seedDefaultCategories = seedDefaultCategories;
