const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const ExportJob = require('../models/ExportJob');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
const fileStore = require('../utils/fileStore');
const { formatDateInZone, isValidTimeZone } = require('../utils/timezone');
const { snappedRouteParts, slug } = require('../utils/tripExport');
require('../models/User');
require('../models/Vehicle');

/**
 * The month, merged: one zip for every driver of a region over one calendar month.
 *
 *   <region>_<YYYY-MM>_raw_gps.kml        every trip as the phone recorded it
 *   <region>_<YYYY-MM>_cleaned_roads.kml  every trip's road-snapped route
 *   <region>_<YYYY-MM>_summary.csv        one row per driver per day
 *
 * Both KMLs are laid out Driver → Day → trip, one colour per driver, each trip time-stamped so
 * Google Earth's time slider can play the month. They open in Google Earth, QGIS and ArcGIS.
 *
 * A month of Australia is ~2.5 million raw GPS points, so nothing is built in memory: trips are
 * read 25 at a time and both files are streamed to disk as they are written, then zipped into
 * GridFS like every other export (services/exportRunner.js runs it, one job at a time).
 *
 * A trip belongs to the month by its LOCAL start date — the trip's own time zone, else its
 * driver's, else the region's — so a Melbourne drive at 08:00 on the 1st is October's, not the
 * UTC 31 September evening it also is. The job's stored filter is the month widened by 14 h either
 * side; the exact cut is made here.
 */

const TRIP_CHUNK = 25;
/** Distinct, readable on satellite and street maps; KML colours are aabbggrr (see kmlColor). */
const DRIVER_COLOURS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
  '#469990', '#9a6324', '#800000', '#808000', '#000075', '#fabed4', '#ffe119', '#dcbeff',
];

const kmlColor = (hex, alpha = 'ff') => {
  const h = hex.replace('#', '').toLowerCase();
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
};
const esc = (v) => String(v ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const km = (m) => (Number(m) / 1000 || 0).toFixed(2);

/** A file written in order, honouring back-pressure, so a 60 MB KML never sits in memory. */
function streamWriter(file) {
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const closed = new Promise((resolve, reject) => { out.on('close', resolve); out.on('error', reject); });
  return {
    async write(text) {
      if (!out.write(text)) await new Promise((resolve) => out.once('drain', resolve));
    },
    async end() {
      out.end();
      await closed;
    },
  };
}

function kmlHead(title, description, driverStyles) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(title)}</name>
  <description>${esc(description)}</description>
${driverStyles}
`;
}

function placemark({ name, style, parts, begin, end, fields }) {
  const lines = parts
    .filter((p) => p.length > 1)
    .map((p) => `<LineString><tessellate>1</tessellate><coordinates>${p.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(' ')}</coordinates></LineString>`);
  if (!lines.length) return '';
  const data = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `<Data name="${k}"><value>${esc(v)}</value></Data>`)
    .join('');
  const span = begin ? `<TimeSpan><begin>${new Date(begin).toISOString()}</begin>${end ? `<end>${new Date(end).toISOString()}</end>` : ''}</TimeSpan>` : '';
  const geometry = lines.length === 1 ? lines[0] : `<MultiGeometry>${lines.join('')}</MultiGeometry>`;
  return `      <Placemark><name>${esc(name)}</name>${span}<styleUrl>#${style}</styleUrl><ExtendedData>${data}</ExtendedData>${geometry}</Placemark>\n`;
}

async function pointsForTrips(ids) {
  const byTrip = new Map(ids.map((id) => [String(id), []]));
  const rows = await LocationPoint.find({ tripId: { $in: ids } })
    .sort({ tripId: 1, recordedAt: 1 })
    .select('tripId lat lon -_id')
    .lean();
  for (const p of rows) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const list = byTrip.get(String(p.tripId));
    if (list) list.push([p.lon, p.lat]);
  }
  return byTrip;
}

const hhmm = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));

/**
 * Build one monthly job's zip and store it. Never throws — failure is recorded on the job.
 * @param opts.dir     scratch directory for the files while they are written
 * @param opts.bucket  GridFS bucket the finished zip goes to
 */
async function runMonthJob(job, { dir, bucket }) {
  const params = job.params || {};
  const month = params.month;
  const regionLabel = params.country || 'All regions';
  const layers = params.layers || 'both';
  const wantRaw = layers !== 'cleaned';
  const wantClean = layers !== 'raw';
  const fallbackTz = isValidTimeZone(params.tz) ? params.tz : 'UTC';
  const base = `${slug(regionLabel) || 'region'}_${month}`;
  const fileName = `monthly_${base}${layers === 'both' ? '' : `_${layers}`}_${String(job._id).slice(-6)}.zip`;
  const rawPath = path.join(dir, `${job._id}_raw.kml`);
  const cleanPath = path.join(dir, `${job._id}_clean.kml`);
  const zipPath = path.join(dir, fileName);
  const scratch = [rawPath, cleanPath, zipPath];
  let stored = null;

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // The light fields only: the routes and points are read 25 trips at a time below.
    const found = await Trip.find(job.filter)
      .select('driverId vehicleId status startedAt endedAt timezone distanceMeters cleanedDistanceMeters pointCount importBatchId mapMatchStatus')
      .populate('driverId', 'name email timezone country')
      .populate('vehicleId', 'plateNumber')
      .lean();
    const zoneOf = (t) => [t.timezone, t.driverId && t.driverId.timezone, fallbackTz].find((z) => z && isValidTimeZone(z));
    const trips = found
      .map((t) => ({ ...t, tz: zoneOf(t), day: formatDateInZone(t.startedAt, zoneOf(t)) }))
      .filter((t) => t.day.startsWith(month) && t.driverId)
      .sort((a, b) => String(a.driverId.name || '').localeCompare(String(b.driverId.name || ''))
        || String(a.driverId._id).localeCompare(String(b.driverId._id))
        || new Date(a.startedAt) - new Date(b.startedAt));

    await ExportJob.updateOne({ _id: job._id }, { $set: { total: trips.length, done: 0 } });
    if (!trips.length) throw new Error(`No trips in ${month} for ${regionLabel}`);

    // One colour per driver, the same in both files.
    const driverIds = [...new Set(trips.map((t) => String(t.driverId._id)))];
    const colourOf = new Map(driverIds.map((id, i) => [id, DRIVER_COLOURS[i % DRIVER_COLOURS.length]]));
    const styles = (width) => driverIds
      .map((id) => `  <Style id="d${id}"><LineStyle><color>${kmlColor(colourOf.get(id))}</color><width>${width}</width></LineStyle></Style>`)
      .join('\n');

    const raw = wantRaw ? streamWriter(rawPath) : null;
    const clean = wantClean ? streamWriter(cleanPath) : null;
    const desc = `${driverIds.length} drivers, ${trips.length} trips, ${month}. Folders: driver, then day. Built ${new Date().toISOString()}.`;
    if (raw) await raw.write(kmlHead(`Raw GPS — ${regionLabel} — ${month}`, `As recorded by the phones. ${desc}`, styles(2)));
    if (clean) await clean.write(kmlHead(`Cleaned roads — ${regionLabel} — ${month}`, `Each trip snapped to the road network. ${desc}`, styles(3)));
    const both = async (fn) => {
      if (raw) await raw.write(fn('raw'));
      if (clean) await clean.write(fn('clean'));
    };

    const summary = new Map(); // `${driverId}|${day}` -> row
    let curDriver = null;
    let curDay = null;
    let done = 0;
    let noCleaned = 0;

    for (let i = 0; i < trips.length; i += TRIP_CHUNK) {
      const batch = trips.slice(i, i + TRIP_CHUNK);
      const ids = batch.map((t) => t._id);
      const [points, shapeDocs] = await Promise.all([
        wantRaw ? pointsForTrips(ids) : new Map(),
        wantClean ? Trip.find({ _id: { $in: ids } }).select('cleanedRouteShapes importBatchId').lean() : [],
      ]);
      const shapesOf = new Map(shapeDocs.map((s) => [String(s._id), s]));

      for (const t of batch) {
        const driverId = String(t.driverId._id);
        const name = t.driverId.name || 'Unknown driver';
        if (driverId !== curDriver) {
          if (curDay) await both(() => '    </Folder>\n');
          if (curDriver) await both(() => '  </Folder>\n');
          await both(() => `  <Folder><name>${esc(name)}</name><description>${esc(t.driverId.email || '')}</description>\n`);
          curDriver = driverId;
          curDay = null;
        }
        if (t.day !== curDay) {
          if (curDay) await both(() => '    </Folder>\n');
          await both(() => `    <Folder><name>${t.day}</name>\n`);
          curDay = t.day;
        }

        const when = `${hhmm(t.startedAt, t.tz)}–${t.endedAt ? hhmm(t.endedAt, t.tz) : 'open'}`;
        const fields = {
          driver: name,
          date: t.day,
          start: new Date(t.startedAt).toISOString(),
          end: t.endedAt ? new Date(t.endedAt).toISOString() : '',
          vehicle: t.vehicleId && t.vehicleId.plateNumber,
          trip_id: String(t._id),
          raw_km: km(t.distanceMeters),
          cleaned_km: t.cleanedDistanceMeters != null ? km(t.cleanedDistanceMeters) : '',
          source: t.importBatchId ? 'imported' : 'app',
        };
        if (raw) {
          const path_ = points.get(String(t._id)) || [];
          await raw.write(placemark({ name: `${when} · ${km(t.distanceMeters)} km`, style: `d${driverId}`, parts: [path_], begin: t.startedAt, end: t.endedAt, fields: { ...fields, gps_points: path_.length } }));
        }
        let hasClean = false;
        if (clean) {
          const doc = shapesOf.get(String(t._id));
          const parts = doc ? snappedRouteParts(doc) : [];
          hasClean = parts.some((p) => p.length > 1);
          if (hasClean) {
            await clean.write(placemark({ name: `${when} · ${km(t.cleanedDistanceMeters)} km`, style: `d${driverId}`, parts, begin: t.startedAt, end: t.endedAt, fields }));
          } else {
            noCleaned += 1;
          }
        }

        const key = `${driverId}|${t.day}`;
        const row = summary.get(key) || {
          driver: name, email: t.driverId.email || '', region: t.driverId.country || '', date: t.day,
          trips: 0, rawM: 0, cleanM: 0, points: 0, noClean: 0,
        };
        row.trips += 1;
        row.rawM += t.distanceMeters || 0;
        row.cleanM += t.cleanedDistanceMeters || 0;
        row.points += wantRaw ? (points.get(String(t._id)) || []).length : (t.pointCount || 0);
        if (clean && !hasClean) row.noClean += 1;
        summary.set(key, row);
        done += 1;
      }

      await ExportJob.updateOne({ _id: job._id }, { $set: { done, fellBackToRaw: noCleaned } });
      await new Promise((r) => setImmediate(r)); // keep the API answering while this runs
    }

    if (curDay) await both(() => '    </Folder>\n');
    if (curDriver) await both(() => '  </Folder>\n');
    await both(() => '</Document>\n</kml>\n');
    if (raw) await raw.end();
    if (clean) await clean.end();

    const csv = [
      ['Driver', 'Email', 'Region', 'Date', 'Trips', 'Raw GPS km', 'Cleaned km', 'GPS points', 'Trips without a cleaned road yet'].join(','),
      ...[...summary.values()].map((r) => [r.driver, r.email, r.region, r.date, r.trips, km(r.rawM), km(r.cleanM), r.points, r.noClean].map(csvCell).join(',')),
    ].join('\r\n');

    // Zip on disk, then into the shared store — the same path every export takes.
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const finished = new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });
    archive.pipe(output);
    if (raw) archive.file(rawPath, { name: `${base}_raw_gps.kml` });
    if (clean) archive.file(cleanPath, { name: `${base}_cleaned_roads.kml` });
    archive.append(`﻿${csv}`, { name: `${base}_summary.csv` });
    await archive.finalize();
    await finished;

    stored = await fileStore.putStream(fs.createReadStream(zipPath), {
      filename: fileName,
      bucketName: bucket,
      contentType: 'application/zip',
      metadata: { jobId: job._id },
    });
    await ExportJob.updateOne(
      { _id: job._id },
      { $set: { status: 'ready', fileName, fileId: stored.id, filePath: null, bytes: stored.bytes, done, fellBackToRaw: noCleaned, completedAt: new Date() } }
    );
  } catch (err) {
    if (stored) await fileStore.remove(stored.id, bucket).catch(() => {});
    await ExportJob.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', error: String(err.message).slice(0, 500), completedAt: new Date() } }
    );
  } finally {
    for (const f of scratch) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* the runner's sweep gets leftovers */ }
    }
  }
}

module.exports = { runMonthJob };
