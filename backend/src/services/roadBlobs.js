const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const mongoose = require('mongoose');
const RoadLink = require('../models/RoadLink');
const WorkArea = require('../models/WorkArea');
const LinkCoverage = require('../models/LinkCoverage');

const gzip = promisify(zlib.gzip);

/**
 * The whole road network of one delivery, at full detail, as one binary file — for the coverage
 * map to draw every road at once with WebGL.
 *
 * The map used to ask for roads a screenful at a time and only past a zoom level, simplified and
 * capped; zoomed out there was nothing, and every pan was another request. A delivery is up to
 * 654,447 links / 2.9 M vertices, which as JSON is hundreds of megabytes — but as typed arrays,
 * delta-encoded and gzipped, it is ~10–15 MB, and a GPU draws it in one go.
 *
 * Built once per delivery and kept in GridFS, keyed by what it contains: the delivery, how many
 * links it holds (a roads-only import adds to it) and which areas it has (a split or a join swaps
 * them). The key is in the URL, so the browser caches the file for good and only a change makes
 * it download again.
 *
 * NOTHING about coverage is in here — that changes every trip. The order of links is fixed (by
 * link id, the order of the unique index), so roadState() below can say "these indices are driven"
 * in a few hundred KB, and the map recolours without touching the geometry.
 *
 * Format (all little-endian):
 *   "RDB1" | uint32 header length | header JSON (utf-8, padded to 8) | sections, each 8-aligned
 *   starts  Uint32 [links + 1]   vertex index at which each link starts
 *   coords  Int32  [vertices * 2] lon,lat in micro-degrees (≈0.1 m), each a delta from the previous
 *                                 vertex — the first from 0. No simplification: every vertex is kept.
 *   fc      Uint8  [links]        functional class, 0 = unknown
 *   area    Uint16 [links]        index into header.areas, 65535 = in no area
 *   ids     Float64 [links]       link ids, when every id is a plain number (else header.ids)
 */

const BUCKET = 'roadBlobs';
const FORMAT = 1;
const SCALE = 1e6;
const NO_AREA = 65535;

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
}

/** What the file for this delivery is called today. Cheap: a count and the area ids. */
async function blobKey(versionId) {
  const [links, areas] = await Promise.all([
    RoadLink.countDocuments({ networkVersionId: versionId }),
    WorkArea.find({ networkVersionId: versionId }).select('_id areaCode').sort({ _id: 1 }).lean(),
  ]);
  const hash = crypto
    .createHash('sha1')
    .update(areas.map((a) => `${a._id}:${a.areaCode}`).join(','))
    .digest('hex')
    .slice(0, 10);
  return { key: `f${FORMAT}-${links}-${hash}`, links };
}

const filename = (versionId, key) => `${versionId}-${key}`;

/** A growable typed array, so a 2.9 M-vertex delivery is never held as JS arrays of numbers. */
function growable(Type, initial = 1 << 16) {
  let arr = new Type(initial);
  let n = 0;
  return {
    push(v) {
      if (n === arr.length) {
        const next = new Type(arr.length * 2);
        next.set(arr);
        arr = next;
      }
      arr[n++] = v;
    },
    get length() { return n; },
    done() { return arr.subarray(0, n); },
  };
}

const pad8 = (n) => (n + 7) & ~7;

/** Read the delivery and write its file. Returns the gzipped bytes. */
async function build(versionId, key) {
  const areas = await WorkArea.find({ networkVersionId: versionId })
    .select('_id areaCode name')
    .sort({ _id: 1 })
    .lean();
  if (areas.length >= NO_AREA) throw new Error('Too many areas for one road file');
  const areaIndex = new Map(areas.map((a, i) => [String(a._id), i]));

  const starts = growable(Uint32Array);
  const coords = growable(Int32Array, 1 << 18);
  const fc = growable(Uint8Array);
  const area = growable(Uint16Array);
  const numericIds = growable(Float64Array);
  let stringIds = null;
  let lastLon = 0;
  let lastLat = 0;
  let vertices = 0;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;

  // The order of the unique index — and therefore the same order roadState() walks.
  const cursor = RoadLink.find({ networkVersionId: versionId })
    .sort({ linkId: 1 })
    .select('linkId funcClass areaId geometry.coordinates -_id')
    .lean()
    .cursor({ batchSize: 5000 });

  for await (const link of cursor) {
    const line = link.geometry && link.geometry.coordinates;
    starts.push(vertices);
    if (Array.isArray(line)) {
      for (const pt of line) {
        const lon = Math.round(pt[0] * SCALE);
        const lat = Math.round(pt[1] * SCALE);
        coords.push(lon - lastLon);
        coords.push(lat - lastLat);
        lastLon = lon;
        lastLat = lat;
        vertices += 1;
        if (pt[0] < w) w = pt[0];
        if (pt[0] > e) e = pt[0];
        if (pt[1] < s) s = pt[1];
        if (pt[1] > n) n = pt[1];
      }
    }
    fc.push(Number(link.funcClass) > 0 && Number(link.funcClass) < 256 ? Number(link.funcClass) : 0);
    const ai = link.areaId ? areaIndex.get(String(link.areaId)) : undefined;
    area.push(ai === undefined ? NO_AREA : ai);
    const id = String(link.linkId);
    // A plain number without leading zeros survives the round trip through a Float64 unchanged.
    if (!stringIds && /^(0|[1-9]\d{0,14})$/.test(id)) {
      numericIds.push(Number(id));
    } else {
      if (!stringIds) {
        // The first id that is not a plain number: everything so far moves to the string list.
        stringIds = Array.from(numericIds.done(), (v) => String(v));
      }
      stringIds.push(id);
    }
  }
  starts.push(vertices);

  const sections = {
    starts: starts.done(),
    coords: coords.done(),
    fc: fc.done(),
    area: area.done(),
    ...(stringIds ? {} : { ids: numericIds.done() }),
  };
  const linkCount = fc.length;
  let offset = 0;
  const layout = {};
  for (const [name, arr] of Object.entries(sections)) {
    layout[name] = [offset, arr.byteLength];
    offset = pad8(offset + arr.byteLength);
  }
  const header = {
    format: FORMAT,
    versionId: String(versionId),
    key,
    linkCount,
    vertexCount: vertices,
    scale: SCALE,
    bbox: linkCount ? [w, s, e, n] : null,
    areas: areas.map((a) => ({ id: String(a._id), code: a.areaCode, name: a.name })),
    ids: stringIds || null,
    sections: layout,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = pad8(headerBytes.length);
  const dataStart = 8 + headerLen;
  const out = Buffer.alloc(dataStart + offset);
  out.write('RDB1', 0, 'ascii');
  out.writeUInt32LE(headerLen, 4);
  headerBytes.copy(out, 8);
  for (const [name, arr] of Object.entries(sections)) {
    Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(out, dataStart + layout[name][0]);
  }
  return gzip(out, { level: 6 });
}

/** Builds in flight, so concurrent requests for the same file share one build. */
const building = new Map();

/** The stored file for this key, building and storing it first if there is none. */
async function ensure(versionId, key) {
  const name = filename(versionId, key);
  const [found] = await bucket().find({ filename: name }).limit(1).toArray();
  if (found) return found;
  if (building.has(name)) return building.get(name);

  const job = (async () => {
    const t = Date.now();
    const gz = await build(versionId, key);
    const file = await new Promise((resolve, reject) => {
      const up = bucket().openUploadStream(name, { metadata: { versionId: String(versionId), key, format: FORMAT } });
      up.on('error', reject);
      up.on('finish', () => resolve(up.gridFSFile || { _id: up.id, length: gz.length }));
      up.end(gz);
    });
    // Older files for this delivery are superseded by this one.
    const stale = await bucket()
      .find({ 'metadata.versionId': String(versionId), filename: { $ne: name } })
      .toArray();
    for (const old of stale) await bucket().delete(old._id).catch(() => {});
    // eslint-disable-next-line no-console
    console.log(`road blob ${name}: ${(gz.length / 1e6).toFixed(1)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return file;
  })();
  building.set(name, job);
  try {
    return await job;
  } finally {
    building.delete(name);
  }
}

function openFile(fileId) {
  return bucket().openDownloadStream(fileId);
}

/** Build the files for these deliveries one after another, quietly — after a deploy or an import. */
async function warm(versionIds) {
  for (const id of versionIds) {
    try {
      const { key, links } = await blobKey(id);
      if (links) await ensure(id, key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('road blob warm-up failed for', String(id), err.message);
    }
  }
}

/* ------------------------------------------------------------------ coverage state */

const gunzip = promisify(zlib.gunzip);

/**
 * A delivery's link ids in file order, for turning "link 1231098806 is driven" into "the 40,212th
 * road in the file". Read once from the stored file and kept: ids are numbers for HERE data (8 bytes
 * each — 5 MB for Victoria), text only for small test networks.
 */
const idCache = new Map(); // `${versionId}-${key}` -> { ids: Float64Array|string[], numeric }
const ID_CACHE_MAX = 8;

async function idsFor(versionId, key) {
  const name = filename(versionId, key);
  if (idCache.has(name)) return idCache.get(name);
  const file = await ensure(versionId, key);
  const chunks = [];
  for await (const c of openFile(file._id)) chunks.push(c);
  const buf = await gunzip(Buffer.concat(chunks));
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen).replace(/ +$/, '').trim());
  let entry;
  if (header.ids) {
    entry = { ids: header.ids, numeric: false };
  } else {
    const [off, len] = header.sections.ids;
    const at = 8 + headerLen + off;
    const copy = new Float64Array(len / 8);
    new Uint8Array(copy.buffer).set(buf.subarray(at, at + len));
    entry = { ids: copy, numeric: true };
  }
  idCache.set(name, entry);
  while (idCache.size > ID_CACHE_MAX) idCache.delete(idCache.keys().next().value);
  return entry;
}

/** Where linkId sits in the file, or -1. The file is in string order, so compare as strings. */
function indexOf(entry, linkId) {
  const { ids, numeric } = entry;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = numeric ? String(ids[mid]) : ids[mid];
    if (at === linkId) return mid;
    if (at < linkId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const stateMemo = new Map();

/**
 * Which links of a delivery are driven, as indices into its road file, with who drove each.
 * Remembered until the delivery's coverage changes (a new first cover, or a clear).
 */
async function coverageIndices(versionId, key) {
  const [count, newest] = await Promise.all([
    LinkCoverage.countDocuments({ networkVersionId: versionId }),
    LinkCoverage.findOne({ networkVersionId: versionId }).sort({ firstAt: -1 }).select('firstAt').lean(),
  ]);
  const stamp = `${key}:${count}:${newest ? new Date(newest.firstAt).getTime() : 0}`;
  const memo = stateMemo.get(String(versionId));
  if (memo && memo.stamp === stamp) return memo.value;

  const indices = new Uint32Array(count);
  const drivers = new Array(count);
  let found = 0;
  if (count) {
    const entry = await idsFor(versionId, key);
    const rows = LinkCoverage.find({ networkVersionId: versionId })
      .select('linkId firstDriverId -_id')
      .lean()
      .cursor({ batchSize: 5000 });
    for await (const row of rows) {
      const at = indexOf(entry, row.linkId);
      if (at < 0) continue; // a ledger row for a road the file no longer has
      indices[found] = at;
      drivers[found] = row.firstDriverId ? String(row.firstDriverId) : null;
      found += 1;
    }
  }
  const value = { indices: indices.subarray(0, found), drivers: drivers.slice(0, found) };
  stateMemo.set(String(versionId), { stamp, value });
  return value;
}

module.exports = { blobKey, build, ensure, openFile, warm, coverageIndices, NO_AREA, FORMAT, BUCKET };
