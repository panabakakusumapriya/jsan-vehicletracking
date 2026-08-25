const fs = require('fs');
const path = require('path');

/**
 * A minimal ESRI shapefile reader — .shp geometry, .dbf attributes, .prj coordinate system.
 *
 * Written rather than pulled in because the format is small, frozen since 1998, and we only need
 * the two shape types the customer sends (Polygon and PolyLine). The alternative is a GDAL
 * binding, which is a native dependency on a platform where builds are already the slowest part
 * of a deploy.
 *
 * Everything reads through a sliding window rather than loading whole files. The first delivery is
 * an 87 MB .dbf beside a 73 MB .shp, and holding both plus 654,447 materialised JavaScript objects
 * would be most of a small container's memory. `forEachFeature` yields one feature at a time so the
 * caller can batch them into Mongo and let each batch go.
 */

const SHAPE_TYPES = {
  0: 'Null',
  1: 'Point',
  3: 'PolyLine',
  5: 'Polygon',
  8: 'MultiPoint',
  11: 'PointZ',
  13: 'PolyLineZ',
  15: 'PolygonZ',
  18: 'MultiPointZ',
  21: 'PointM',
  23: 'PolyLineM',
  25: 'PolygonM',
  28: 'MultiPointM',
};

const WINDOW = 4 * 1024 * 1024;

/** A file read through a sliding window, so callers can address absolute offsets cheaply. */
class Window {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.buf = Buffer.alloc(0);
    this.start = 0;
  }

  /** Guarantee [offset, offset+length) is resident, then return the buffer-relative index. */
  at(offset, length) {
    if (offset < this.start || offset + length > this.start + this.buf.length) {
      const want = Math.max(WINDOW, length);
      const size = Math.min(want, this.size - offset);
      if (size < length) {
        throw new Error(`shapefile: truncated — wanted ${length} bytes at ${offset}`);
      }
      if (this.buf.length !== size) this.buf = Buffer.alloc(size);
      fs.readSync(this.fd, this.buf, 0, size, offset);
      this.start = offset;
    }
    return offset - this.start;
  }
}

/* ------------------------------------------------------------------ .prj */

/**
 * The .prj is an ESRI WKT string on one line. We do not reproject — both layers in the first
 * delivery are already geographic degrees — but the datum has to be recorded and reported,
 * because the first delivery's two files disagreed (GDA94 boundaries, WGS84 roads: ~1.8 m apart
 * in Victoria, widening ~7 cm a year as the plate moves).
 */
function readPrj(prjPath) {
  if (!fs.existsSync(prjPath)) return { wkt: null, name: null, datum: null, projected: false };
  const wkt = fs.readFileSync(prjPath, 'utf8').trim();
  const name = /^\s*(?:GEOGCS|PROJCS)\["([^"]+)"/.exec(wkt)?.[1] || null;
  const datum = /DATUM\["([^"]+)"/.exec(wkt)?.[1] || null;
  return { wkt, name, datum, projected: /^\s*PROJCS/.test(wkt) };
}

/**
 * Is this datum close enough to WGS84 that GPS traces can be compared against it directly?
 *
 * GDA94 counts: it was defined coincident with WGS84 at epoch 1994 and has drifted about 1.8 m
 * since. That is below the accuracy of the GPS traces being matched, so treating it as WGS84 is
 * honest — but only if we say so out loud in the import report rather than silently.
 */
function datumOffsetNote(datum) {
  if (!datum) return { compatible: false, note: 'No .prj — coordinate system unknown' };
  const d = datum.toUpperCase();
  if (d.includes('WGS_1984') || d.includes('WGS84')) return { compatible: true, note: null };
  if (d.includes('GDA_1994') || d.includes('GDA94')) {
    return {
      compatible: true,
      note: 'GDA94 differs from WGS84 by roughly 1.8 m in south-east Australia and widens ~7 cm/yr. Below GPS noise, so coordinates are used as-is.',
    };
  }
  if (d.includes('GDA2020')) {
    return {
      compatible: true,
      note: 'GDA2020 is within about 0.1 m of current WGS84. Coordinates are used as-is.',
    };
  }
  return {
    compatible: false,
    note: `Datum "${datum}" is not a recognised WGS84-compatible datum. Coordinates may be offset; reproject before importing.`,
  };
}

/* ------------------------------------------------------------------ .dbf */

/**
 * dBase III attribute table. Fixed-length records, so a record is a seek rather than a scan —
 * which is what lets the .dbf be read in lockstep with the .shp without holding either in full.
 */
class DbfReader {
  constructor(dbfPath, encoding = 'utf8') {
    this.fd = fs.openSync(dbfPath, 'r');
    this.size = fs.statSync(dbfPath).size;
    this.encoding = encoding;

    const head = Buffer.alloc(32);
    fs.readSync(this.fd, head, 0, 32, 0);
    this.recordCount = head.readUInt32LE(4);
    this.headerLength = head.readUInt16LE(8);
    this.recordLength = head.readUInt16LE(10);

    const fieldBlock = Buffer.alloc(this.headerLength);
    fs.readSync(this.fd, fieldBlock, 0, this.headerLength, 0);

    this.fields = [];
    let offset = 1; // byte 0 of each record is the deletion flag
    for (let o = 32; o < this.headerLength - 1; o += 32) {
      if (fieldBlock[o] === 0x0d) break;
      const field = {
        name: fieldBlock.toString('latin1', o, o + 11).replace(/\0.*$/, '').trim(),
        type: String.fromCharCode(fieldBlock[o + 11]),
        length: fieldBlock[o + 16],
        decimals: fieldBlock[o + 17],
        offset,
      };
      offset += field.length;
      this.fields.push(field);
    }

    this.window = new Window(this.fd, this.size);
  }

  /** Field metadata for the import report and the column-mapping UI. */
  describe() {
    return this.fields.map((f) => ({
      name: f.name,
      type: f.type,
      length: f.length,
      decimals: f.decimals,
    }));
  }

  record(i) {
    const base = this.headerLength + i * this.recordLength;
    const rel = this.window.at(base, this.recordLength);
    const row = {};
    for (const f of this.fields) {
      const raw = this.window.buf.toString(this.encoding, rel + f.offset, rel + f.offset + f.length).trim();
      if (f.type === 'N' || f.type === 'F') {
        row[f.name] = raw === '' ? null : Number(raw);
      } else if (f.type === 'L') {
        row[f.name] = raw === '' ? null : /^[YyTt]$/.test(raw);
      } else if (f.type === 'D') {
        // yyyymmdd, kept as a string — these are source metadata, never arithmetic.
        row[f.name] = raw || null;
      } else {
        row[f.name] = raw;
      }
    }
    return row;
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ .shp */

class ShpReader {
  constructor(shpPath) {
    this.fd = fs.openSync(shpPath, 'r');
    this.size = fs.statSync(shpPath).size;

    const head = Buffer.alloc(100);
    fs.readSync(this.fd, head, 0, 100, 0);
    if (head.readInt32BE(0) !== 9994) throw new Error('shapefile: .shp file code is not 9994');

    this.shapeType = head.readInt32LE(32);
    this.shapeTypeName = SHAPE_TYPES[this.shapeType] || `Unknown(${this.shapeType})`;
    this.bbox = [
      head.readDoubleLE(36),
      head.readDoubleLE(44),
      head.readDoubleLE(52),
      head.readDoubleLE(60),
    ];
    // The header's own length field is in 16-bit words and counts the header itself.
    this.contentEnd = head.readInt32BE(24) * 2;
    this.window = new Window(this.fd, this.size);
  }

  /**
   * Walk every record in file order, yielding `{ index, type, parts }` where `parts` is an array
   * of [lon, lat][] rings. Null shapes yield empty parts rather than being skipped, so the index
   * stays aligned with the .dbf record number.
   */
  *features() {
    let offset = 100;
    let index = 0;
    const end = Math.min(this.contentEnd, this.size);

    while (offset + 8 <= end) {
      const hRel = this.window.at(offset, 8);
      const contentLength = this.window.buf.readInt32BE(hRel + 4) * 2;
      if (contentLength <= 0 || offset + 8 + contentLength > end) break;

      const rel = this.window.at(offset + 8, contentLength);
      const buf = this.window.buf;
      const type = buf.readInt32LE(rel);

      if (type === 0) {
        yield { index: index++, type, parts: [] };
        offset += 8 + contentLength;
        continue;
      }

      const numParts = buf.readInt32LE(rel + 36);
      const numPoints = buf.readInt32LE(rel + 40);
      const partsAt = rel + 44;
      const pointsAt = partsAt + numParts * 4;

      const parts = [];
      for (let p = 0; p < numParts; p++) {
        const start = buf.readInt32LE(partsAt + p * 4);
        const stop = p + 1 < numParts ? buf.readInt32LE(partsAt + (p + 1) * 4) : numPoints;
        const ring = new Array(stop - start);
        for (let j = start; j < stop; j++) {
          const at = pointsAt + j * 16;
          ring[j - start] = [buf.readDoubleLE(at), buf.readDoubleLE(at + 8)];
        }
        parts.push(ring);
      }

      yield { index: index++, type, parts };
      offset += 8 + contentLength;
    }
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ bundle */

/**
 * Locate the sibling files of a shapefile inside an extracted directory.
 *
 * A shapefile is not one file, and a customer zip routinely carries a __MACOSX folder, a nested
 * directory, or several unrelated layers. So: find every .shp, and report them all rather than
 * silently picking one.
 */
function findShapefiles(dir) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__MACOSX') continue;
        walk(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith('.shp') && !entry.name.startsWith('.')) {
        const base = full.slice(0, -4);
        found.push({
          name: entry.name.slice(0, -4),
          shp: full,
          shx: `${base}.shx`,
          dbf: `${base}.dbf`,
          prj: `${base}.prj`,
          cpg: `${base}.cpg`,
          bytes: fs.statSync(full).size,
        });
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.bytes - a.bytes);
}

/** The .cpg names the .dbf's text encoding; UTF-8 in the first delivery, latin1 historically. */
function readCpg(cpgPath) {
  if (!fs.existsSync(cpgPath)) return 'latin1';
  const raw = fs.readFileSync(cpgPath, 'utf8').trim().toUpperCase();
  if (raw.includes('UTF-8') || raw.includes('UTF8') || raw === '65001') return 'utf8';
  return 'latin1';
}

/**
 * Lazily yield `{ attrs, parts, index }` for every feature in a bundle.
 *
 * A generator rather than a callback so a caller that has to await between features — the import
 * committer, batching inserts into Mongo — can do so without first materialising 654,447 objects.
 * `for (const f of features(bundle)) { await ... }` is legal inside an async function and keeps
 * peak memory at one batch. Closing is handled in `finally`, which the runtime also runs when the
 * consumer breaks out early.
 */
function* features(bundle) {
  const encoding = readCpg(bundle.cpg);
  const shp = new ShpReader(bundle.shp);
  const dbf = fs.existsSync(bundle.dbf) ? new DbfReader(bundle.dbf, encoding) : null;
  try {
    for (const feature of shp.features()) {
      const attrs = dbf && feature.index < dbf.recordCount ? dbf.record(feature.index) : {};
      yield { attrs, parts: feature.parts, index: feature.index };
    }
  } finally {
    shp.close();
    if (dbf) dbf.close();
  }
}

/**
 * Synchronous convenience wrapper over `features` for callers that never need to await —
 * the preflight pass, which only accumulates counters.
 */
function forEachFeature(bundle, onFeature, { onProgress = null, progressEvery = 25000 } = {}) {
  let count = 0;
  for (const { attrs, parts, index } of features(bundle)) {
    onFeature(attrs, parts, index);
    count++;
    if (onProgress && count % progressEvery === 0) onProgress(count);
  }
  return count;
}

/** Header-only peek: shape type, extent, attribute columns. Used to build the mapping UI. */
function inspect(bundle) {
  const encoding = readCpg(bundle.cpg);
  const shp = new ShpReader(bundle.shp);
  const dbf = fs.existsSync(bundle.dbf) ? new DbfReader(bundle.dbf, encoding) : null;
  try {
    const sample = [];
    if (dbf) for (let i = 0; i < Math.min(3, dbf.recordCount); i++) sample.push(dbf.record(i));
    return {
      name: bundle.name,
      shapeType: shp.shapeType,
      shapeTypeName: shp.shapeTypeName,
      bbox: shp.bbox,
      prj: readPrj(bundle.prj),
      encoding,
      fields: dbf ? dbf.describe() : [],
      recordCount: dbf ? dbf.recordCount : 0,
      sample,
    };
  } finally {
    shp.close();
    if (dbf) dbf.close();
  }
}

module.exports = {
  SHAPE_TYPES,
  DbfReader,
  ShpReader,
  readPrj,
  readCpg,
  datumOffsetNote,
  findShapefiles,
  features,
  forEachFeature,
  inspect,
};
