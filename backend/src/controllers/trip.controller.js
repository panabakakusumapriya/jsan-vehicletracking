const fs = require('fs');
const archiver = require('archiver');
const mongoose = require('mongoose');
const Trip = require('../models/Trip');
const User = require('../models/User');
const LocationPoint = require('../models/LocationPoint');
const ExportJob = require('../models/ExportJob');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { dayRange, isValidTimeZone } = require('../utils/timezone');
const { timezoneForCountry } = require('../utils/countryTimezone');
const { buildKml, buildSnappedKml, buildJson, buildMergedKml, buildMergedSnappedKml, buildMergedJson, baseFilename, driverName, vehiclePlate, slug, filenameDate } = require('../utils/tripExport');
const { decodePolyline6 } = require('../services/roadSegments');

/**
 * Points for many trips in ONE query, grouped by trip id.
 *
 * Replaces `for (trip of trips) await LocationPoint.find({tripId})`, which cost a round trip per
 * trip — 60 trips on a Reports day meant 60 sequential queries for data a single `$in` returns.
 * Same documents either way; the saving is latency, and it scales with how busy the day was.
 *
 * Sorted by `{tripId, recordedAt}` on purpose: that matches the compound index on LocationPoint,
 * so Mongo walks the index in order and never has to sort thousands of points in memory.
 */
async function pointsByTrip(tripIds) {
  const byTrip = new Map(tripIds.map((id) => [String(id), []]));
  if (!tripIds.length) return byTrip;

  const all = await LocationPoint.find({ tripId: { $in: tripIds } })
    .sort({ tripId: 1, recordedAt: 1 })
    .select('tripId lat lon speedKmh heading recordedAt')
    .lean();

  for (const p of all) {
    const arr = byTrip.get(String(p.tripId));
    if (arr) arr.push(p);
  }
  return byTrip;
}

/**
 * A trip's stored snapped geometry as drawable paths. Returns null when the trip was never
 * matched, so callers can fall back to the raw trace rather than emitting an empty file.
 */
function snappedPathsFor(trip) {
  if (!trip.cleanedRouteShapes || !trip.cleanedRouteShapes.length) return null;
  return {
    route: trip.cleanedRouteShapes.flatMap((sh) => decodePolyline6(sh)).map((pt) => [pt.lon, pt.lat]),
    ukm: (trip.ukmNewShapes || []).map((sh) => decodePolyline6(sh).map((pt) => [pt.lon, pt.lat])),
  };
}

// Shared by list(), exportBulk() and mergedSummary() — the exact same status/driverId(s)/date
// filtering rules apply everywhere trips get filtered, so this is the one place that logic
// lives rather than three copies drifting apart.
//
// from/to are plain YYYY-MM-DD strings, matched with no timezone conversion: `from` parses as
// UTC midnight, `to` parses in the server's own local time. Deliberate — this endpoint does
// not know or care what timezone the viewer or the driver is in. See the Trips page for how
// the result is displayed (also deliberately viewer-local, with no conversion either).
// A query-string id is always a plain string. Mongoose auto-casts a string to ObjectId for
// .find()-style queries, but NOT inside .aggregate() pipelines (mergedSummary uses this same
// filter in a $match stage) — those hit MongoDB directly with whatever's in the pipeline, and
// a string never equals an ObjectId under Mongo's own comparison, so an uncast id here would
// silently match zero documents in an aggregation while working fine in .find(). Casting
// explicitly makes this filter correct for both. Falls back to the raw string for something
// that isn't a valid ObjectId, so .find() still produces its own CastError as before rather
// than this function swallowing bad input silently.
const toObjectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);

function buildTripFilter(req, scope) {
  const filter = { ...scope };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.driverId) {
    filter.driverId = toObjectId(req.query.driverId);
  } else if (req.query.driverIds !== undefined) {
    // Present-but-possibly-empty means "match exactly this set" — a project/country combo
    // that resolves to zero drivers must return zero trips, not silently fall through to
    // "no filter at all" and show the whole fleet. `{ $in: [] }` correctly matches nothing.
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    filter.driverId = { $in: ids.map(toObjectId) };
  }
  if (req.query.from || req.query.to) {
    // Both ends resolved in ONE timezone - the viewer's when the client sends it, UTC otherwise.
    //
    // This previously took the lower bound as UTC midnight and the upper as 23:59:59 in whatever
    // timezone the SERVER happened to run in. Those are different clocks: on a UTC+5:30 host a
    // single-day filter covered 00:00Z to 18:29Z and silently dropped the last five and a half
    // hours of the day, and the size of that hole moved with the deploy region.
    //
    // The other half of the bug was that the list renders times in the VIEWER's timezone while
    // filtering in UTC, so a trip starting 21:36Z displays as the 18th to a +5:30 viewer but is
    // filed under the 17th by the filter and disappears from a same-day search. 58 of 1031 trips
    // (5.6%) fall on a different calendar day under those two clocks.
    const zone = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
    filter.startedAt = {};
    if (req.query.from) filter.startedAt.$gte = dayRange(req.query.from, zone).from;
    // Half-open upper bound: dayRange(to).to is midnight at the START of the next day, so $lt
    // covers every instant of the chosen day without a 23:59:59 fudge losing the final second.
    if (req.query.to) filter.startedAt.$lt = dayRange(req.query.to, zone).to;
  }
  return filter;
}

// GET /api/trips?status=&driverId=&from=&to=&limit=&page=
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);

  const [trips, total] = await Promise.all([
    Trip.find(filter)
      .sort({ startedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('driverId', 'name email')
      .populate('vehicleId', 'plateNumber'),
    Trip.countDocuments(filter),
  ]);

  res.json({ trips, total, page, limit });
});

// GET /api/trips/:id  (+ ?points=true for the full path)
exports.getOne = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const trip = await Trip.findOne({ _id: req.params.id, ...scope })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  let points;
  if (req.query.points === 'true') {
    const raw = await LocationPoint.find({ tripId: trip._id })
      .sort({ recordedAt: 1 })
      .select('lat lon speedKmh heading recordedAt');

    // Raw points, unmodified. The trip doc itself (already in `trip` above) carries the
    // Valhalla-matched layer: cleanedDistanceMeters + cleanedRouteShapes, once mapMatchStatus
    // is 'matched' — see services/mapMatcher.js. The frontend toggle picks between them.
    points = raw;
  }
  res.json({ trip, points });
});

// GET /api/trips/:id/export?format=kml|json
exports.exportOne = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const trip = await Trip.findOne({ _id: req.params.id, ...scope })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  // ?layer=snapped exports the map-matched route (plus its UKM stretches as a separate styled
  // layer) instead of the raw trace. Falls back to raw when the trip has no snapped geometry, so
  // the caller always gets a usable file rather than an empty one.
  const wantSnapped = req.query.layer === 'snapped' && !!trip.cleanedRouteShapes?.length;
  const filename = `${baseFilename(trip)}${wantSnapped ? '_snapped' : ''}`;

  if (wantSnapped && format !== 'json') {
    const snappedPath = trip.cleanedRouteShapes.flatMap((s) => decodePolyline6(s)).map((p) => [p.lon, p.lat]);
    const ukmPaths = (trip.ukmNewShapes || []).map((s) => decodePolyline6(s).map((p) => [p.lon, p.lat]));
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
    return res.send(buildSnappedKml(trip, snappedPath, ukmPaths));
  }

  const points = await LocationPoint.find({ tripId: trip._id })
    .sort({ recordedAt: 1 })
    .select('lat lon speedKmh heading recordedAt');

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.send(JSON.stringify(buildJson(trip, points), null, 2));
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
  res.send(buildKml(trip, points));
});

/* ───────────────────────── background bulk export ─────────────────────────
 * A zip of every trip in a range is unbounded work, and the snapped variant decodes a polyline
 * per trip on top. Streaming that inside the request left the browser holding an open connection
 * until it finished or a proxy cut it mid-stream — and a truncated zip still looks like a
 * successful download until you open it. These three endpoints replace that: create a job, poll
 * it, download the finished artifact. See services/exportRunner.js.
 */

// POST /api/trips/export-jobs   { format, layer, ...same filters as /export }
exports.createExportJob = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter({ query: { ...req.query, ...req.body } }, scope);

  const total = await Trip.countDocuments(filter);
  if (!total) return res.status(404).json({ error: 'No trips match these filters' });

  const job = await ExportJob.create({
    requestedBy: req.user._id,
    format: (req.body.format || req.query.format) === 'json' ? 'json' : 'kml',
    layer: (req.body.layer || req.query.layer) === 'snapped' ? 'snapped' : 'raw',
    // Scope is resolved NOW and frozen into the job. Re-deriving it when the worker runs would
    // let a later permission change alter what an already-requested export contains.
    filter,
    total,
  });

  res.status(202).json({ jobId: job._id, status: job.status, total });
});

// GET /api/trips/export-jobs/:id
exports.getExportJob = asyncHandler(async (req, res) => {
  const job = await ExportJob.findOne({ _id: req.params.id, requestedBy: req.user._id }).lean();
  if (!job) return res.status(404).json({ error: 'Export job not found' });
  res.json({
    jobId: job._id,
    status: job.status,
    total: job.total,
    done: job.done,
    fellBackToRaw: job.fellBackToRaw,
    bytes: job.bytes,
    fileName: job.fileName,
    error: job.error,
  });
});

// GET /api/trips/export-jobs/:id/download
exports.downloadExportJob = asyncHandler(async (req, res) => {
  const job = await ExportJob.findOne({ _id: req.params.id, requestedBy: req.user._id });
  if (!job) return res.status(404).json({ error: 'Export job not found' });
  if (job.status !== 'ready') return res.status(409).json({ error: `Export is ${job.status}` });
  if (!job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(410).json({ error: 'Export file has been cleaned up — please run it again' });
  }
  res.download(job.filePath, job.fileName);
});

// GET /api/trips/export-merged?driverId=&date=&format=kml|json
// Merges ALL trips for a single driver on a single date into one file.
exports.exportMerged = asyncHandler(async (req, res) => {
  const { driverId, date, format: fmt } = req.query;
  const format = fmt === 'json' ? 'json' : 'kml';
  if (!driverId || !date) return res.status(400).json({ error: 'driverId and date are required' });

  const scope = await accessibleDriverFilter(req.user);
  const driver = await User.findById(driverId).select('country');
  const tz = timezoneForCountry(driver?.country);
  let range;
  try {
    range = dayRange(date, tz);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: range.from, $lt: range.to },
    ...scope,
  })
    .sort({ startedAt: 1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  if (!trips.length) return res.status(404).json({ error: 'No trips found for this driver on this date' });

  // One query for every trip's points rather than one per trip. Bounded work: this endpoint is
  // already scoped to a single driver on a single date.
  const byTrip = await pointsByTrip(trips.map((t) => t._id));
  const tripsWithPoints = trips.map((trip) => ({ trip, points: byTrip.get(String(trip._id)) || [] }));

  // ?layer=snapped merges the map-matched routes instead of the raw traces.
  if (req.query.layer === 'snapped' && format !== 'json') {
    const withPaths = trips.map((trip) => {
      const paths = snappedPathsFor(trip);
      return { trip, route: paths ? paths.route : null, ukm: paths ? paths.ukm : [] };
    });
    if (withPaths.some((t) => t.route)) {
      const dn = driverName(trips[0]);
      res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
      res.setHeader('Content-Disposition', `attachment; filename="merged_${slug(dn)}_${date}_snapped.kml"`);
      return res.send(buildMergedSnappedKml(dn, vehiclePlate(trips[0]), date, withPaths));
    }
    // Nothing matched on this day — fall through to the raw merge rather than send an empty file.
  }

  const dName = driverName(trips[0]);
  const vPlate = vehiclePlate(trips[0]);
  const filename = `merged_${slug(dName)}_${date}`;

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.send(JSON.stringify(buildMergedJson(dName, vPlate, date, tripsWithPoints), null, 2));
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.kml"`);
  res.send(buildMergedKml(dName, vPlate, date, tripsWithPoints));
});

// GET /api/trips/merged-points?driverId=&date=
// Returns all points for a driver on a single date, merged across trips, for map display.
exports.mergedPoints = asyncHandler(async (req, res) => {
  const { driverId, date } = req.query;
  if (!driverId || !date) return res.status(400).json({ error: 'driverId and date are required' });

  const scope = await accessibleDriverFilter(req.user);
  const driver = await User.findById(driverId).select('country');
  const tz = timezoneForCountry(driver?.country);
  let range;
  try {
    range = dayRange(date, tz);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const trips = await Trip.find({
    driverId,
    startedAt: { $gte: range.from, $lt: range.to },
    ...scope,
  })
    .sort({ startedAt: 1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  const tripsData = [];
  let totalDistance = 0;
  let totalDistanceCleaned = 0;
  let matchedTrips = 0;
  let maxSpeed = 0;
  let totalPoints = 0;

  // Same again: one $in query for the whole day instead of a round trip per trip.
  const byTrip = await pointsByTrip(trips.map((t) => t._id));

  for (const trip of trips) {
    const points = byTrip.get(String(trip._id)) || [];
    tripsData.push({
      tripId: trip._id,
      status: trip.status,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt,
      distanceMeters: trip.distanceMeters,
      cleanedDistanceMeters: trip.cleanedDistanceMeters,
      cleanedRouteShapes: trip.cleanedRouteShapes || [],
      mapMatchStatus: trip.mapMatchStatus,
      maxSpeedKmh: trip.maxSpeedKmh,
      points,
    });
    totalDistance += trip.distanceMeters || 0;
    totalDistanceCleaned += trip.cleanedDistanceMeters ?? trip.distanceMeters ?? 0;
    if (trip.mapMatchStatus === 'matched') matchedTrips += 1;
    maxSpeed = Math.max(maxSpeed, trip.maxSpeedKmh || 0);
    totalPoints += points.length;
  }

  res.json({
    driverName: trips.length ? driverName(trips[0]) : '',
    vehiclePlate: trips.length ? vehiclePlate(trips[0]) : null,
    date,
    timezone: tz,
    totalTrips: trips.length,
    totalDistance,
    totalDistanceCleaned,
    matchedTrips,
    maxSpeed,
    totalPoints,
    trips: tripsData,
  });
});

// GET /api/trips/merged-summary?status=&driverId=&driverIds=&from=&to=&limit=&page=
//
// One row per driver+calendar-day (the Trips page's grouped view, and the Reports overview).
// Same status/driverId(s)/date filters as list()/exportBulk() — a manager filtering Trips by
// project must see that same scoping reflected in the grouped view, not just the flat one.
//
// Paginates over DAY-GROUPS, not raw trips: `total` is the number of distinct driver+day rows
// matching the filter, computed in the same aggregation pass (via $facet) rather than a second
// query, so the count can never drift from what was actually grouped.
exports.mergedSummary = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);

  // Each trip's calendar day depends on the timezone it happened in, not the server's/UTC — a
  // trip starting just after local midnight for a Singapore driver (UTC+8) must bucket into
  // that local day, not silently merge into the previous UTC day. Resolved from each driver's
  // stored `country` (see utils/countryTimezone.js) and looked up for every driver up front,
  // since the zone has to be known BEFORE $group buckets by day below, not after.
  const drivers = await User.find({}).select('name country');
  const driverNameMap = new Map(drivers.map((d) => [d._id.toString(), d.name]));
  // Kept so each row can report the zone it was bucketed in. Without it the caller has no way to
  // ask for that same day back: expanding a row queried /api/trips in UTC while the row itself had
  // been grouped in the driver's local zone, so an Australian trip starting 21:36Z was filed under
  // the 18th here and under the 17th there — the row expanded to nothing and offered no Details
  // link. The grouping zone has to travel with the row.
  const driverTzMap = new Map(drivers.map((d) => [d._id.toString(), timezoneForCountry(d.country)]));
  const tzBranches = drivers.map((d) => ({
    case: { $eq: ['$driverId', d._id] },
    then: timezoneForCountry(d.country),
  }));

  const pipeline = [
    { $match: filter },
    {
      $addFields: {
        dateStr: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$startedAt',
            timezone: tzBranches.length ? { $switch: { branches: tzBranches, default: 'UTC' } } : 'UTC',
          },
        },
      },
    },
    {
      $group: {
        _id: { driverId: '$driverId', date: '$dateStr' },
        totalTrips: { $sum: 1 },
        totalDistance: { $sum: '$distanceMeters' },
        // Falls back to raw per-trip when a trip hasn't been matched yet (or never will be —
        // too short, or the match failed), so this total is always displayable, just not
        // uniformly "cleaned" until every trip in the group has matched. matchedTrips below
        // tells the caller how much of the group that actually is.
        totalDistanceCleaned: { $sum: { $ifNull: ['$cleanedDistanceMeters', '$distanceMeters'] } },
        matchedTrips: { $sum: { $cond: [{ $eq: ['$mapMatchStatus', 'matched'] }, 1, 0] } },
        maxSpeed: { $max: '$maxSpeedKmh' },
        firstStart: { $min: '$startedAt' },
        lastEnd: { $max: '$endedAt' },
        anyActive: { $max: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      },
    },
    { $sort: { firstStart: -1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        totalCount: [{ $count: 'count' }],
      },
    },
  ];

  const [facetResult] = await Trip.aggregate(pipeline);
  const results = facetResult?.rows || [];
  const total = facetResult?.totalCount?.[0]?.count || 0;

  const summaries = results.map((r) => ({
    driverId: r._id.driverId,
    driverName: driverNameMap.get(r._id.driverId.toString()) || 'Unknown',
    date: r._id.date,
    timezone: driverTzMap.get(r._id.driverId.toString()) || 'UTC',
    totalTrips: r.totalTrips,
    totalDistance: r.totalDistance || 0,
    totalDistanceCleaned: r.totalDistanceCleaned || 0,
    matchedTrips: r.matchedTrips || 0,
    maxSpeed: r.maxSpeed || 0,
    firstStart: r.firstStart,
    lastEnd: r.lastEnd,
    anyActive: Boolean(r.anyActive),
  }));

  res.json({ summaries, total, page, limit });
});

// GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=
exports.exportBulk = asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'kml';
  const scope = await accessibleDriverFilter(req.user);
  const filter = buildTripFilter(req, scope);

  const trips = await Trip.find(filter)
    .sort({ startedAt: -1 })
    .populate('driverId', 'name email')
    .populate('vehicleId', 'plateNumber');

  // Snapped variant is resolved per trip below, so a mixed range still produces a full zip.
  const wantSnapped = req.query.layer === 'snapped';
  const rangeLabel = req.query.from || req.query.to ? `${req.query.from || 'start'}_${req.query.to || 'now'}` : 'all';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="trips_${rangeLabel}${wantSnapped ? '_snapped' : ''}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.destroy(err));
  archive.pipe(res);

  // Batched, but NOT all at once. This export is unbounded — it can span every trip in a date
  // range — and the whole design here is to stream each trip into the zip and let it go. Pulling
  // every point for hundreds of trips into memory first would trade a latency win for an
  // out-of-memory risk. Chunking cuts the round trips ~25x while keeping peak memory to one chunk.
  const CHUNK = 25;
  for (let i = 0; i < trips.length; i += CHUNK) {
    const batch = trips.slice(i, i + CHUNK);
    const byTrip = await pointsByTrip(batch.map((t) => t._id));
    for (const trip of batch) {
      const points = byTrip.get(String(trip._id)) || [];
      const filename = baseFilename(trip);
      if (format === 'json') {
        archive.append(JSON.stringify(buildJson(trip, points), null, 2), { name: `${filename}.json` });
        continue;
      }
      // Per trip, not per request: a range will mix matched and unmatched trips, and a trip with
      // no snapped route still deserves its raw file rather than being dropped from the zip.
      const snapped = wantSnapped ? snappedPathsFor(trip) : null;
      if (snapped) {
        archive.append(buildSnappedKml(trip, snapped.route, snapped.ukm), { name: `${filename}_snapped.kml` });
      } else {
        archive.append(buildKml(trip, points), { name: `${filename}.kml` });
      }
    }
  }

  await archive.finalize();
});
