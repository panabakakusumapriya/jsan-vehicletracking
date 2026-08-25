const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

/**
 * Extract a zip to a directory, streaming each entry through inflate rather than buffering it.
 *
 * A shapefile is six or seven sibling files, so the upload has to be a zip — and the first
 * delivery's network layer is 73 MB of .shp beside 87 MB of .dbf. Decompressing those into memory
 * before writing would double the peak for no reason, hence the stream-to-disk approach.
 *
 * Entries are located through the CENTRAL DIRECTORY rather than by walking local headers forward.
 * That matters: an archive written by a streaming producer stores sizes in a trailing data
 * descriptor and leaves the local header's size fields zero, which makes forward-walking guess.
 * The central directory always has the real numbers.
 *
 * `archiver` is already a dependency but only writes; there is no read side to reuse.
 */

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

const MAX_COMMENT = 0xffff;

/** Find the end-of-central-directory record by scanning backwards over the possible comment. */
function findEocd(fd, size) {
  const readLen = Math.min(size, MAX_COMMENT + 22);
  const buf = Buffer.alloc(readLen);
  fs.readSync(fd, buf, 0, readLen, size - readLen);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return {
        entries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
        absolute: size - readLen + i,
        buf,
        relative: i,
      };
    }
  }
  return null;
}

/** Follow the ZIP64 locator when the classic EOCD fields are saturated with 0xFFFFFFFF. */
function resolveZip64(fd, size, eocd) {
  const needs =
    eocd.entries === 0xffff || eocd.cdSize === 0xffffffff || eocd.cdOffset === 0xffffffff;
  if (!needs) return eocd;

  for (let i = eocd.relative - 20; i >= 0; i--) {
    if (eocd.buf.readUInt32LE(i) !== EOCD64_LOCATOR_SIG) continue;
    const eocd64At = Number(eocd.buf.readBigUInt64LE(i + 8));
    const head = Buffer.alloc(56);
    fs.readSync(fd, head, 0, 56, eocd64At);
    if (head.readUInt32LE(0) !== EOCD64_SIG) break;
    return {
      ...eocd,
      entries: Number(head.readBigUInt64LE(32)),
      cdSize: Number(head.readBigUInt64LE(40)),
      cdOffset: Number(head.readBigUInt64LE(48)),
    };
  }
  throw new Error('unzip: archive looks like ZIP64 but the locator is missing or malformed');
}

/** ZIP64 extended information extra field (0x0001) — only present for saturated values. */
function readZip64Extra(extra, entry) {
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const len = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let p = at + 4;
      if (entry.uncompressedSize === 0xffffffff && p + 8 <= at + 4 + len) {
        entry.uncompressedSize = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      if (entry.compressedSize === 0xffffffff && p + 8 <= at + 4 + len) {
        entry.compressedSize = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && p + 8 <= at + 4 + len) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(p));
        p += 8;
      }
      return;
    }
    at += 4 + len;
  }
}

/** Parse the central directory into entry descriptors. */
function readCentralDirectory(fd, eocd) {
  const cd = Buffer.alloc(eocd.cdSize);
  fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset);

  const entries = [];
  let at = 0;
  while (at + 46 <= cd.length && cd.readUInt32LE(at) === CDFH_SIG) {
    const nameLen = cd.readUInt16LE(at + 28);
    const extraLen = cd.readUInt16LE(at + 30);
    const commentLen = cd.readUInt16LE(at + 32);

    const entry = {
      name: cd.toString('utf8', at + 46, at + 46 + nameLen),
      method: cd.readUInt16LE(at + 10),
      compressedSize: cd.readUInt32LE(at + 20),
      uncompressedSize: cd.readUInt32LE(at + 24),
      localHeaderOffset: cd.readUInt32LE(at + 42),
    };
    if (extraLen) {
      readZip64Extra(cd.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen), entry);
    }
    entries.push(entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Where an entry's compressed bytes actually start.
 *
 * The local header repeats the name and extra field but their lengths can differ from the central
 * directory's, so the data offset has to be computed from the local header, not assumed.
 */
function dataOffset(fd, entry) {
  const head = Buffer.alloc(30);
  fs.readSync(fd, head, 0, 30, entry.localHeaderOffset);
  if (head.readUInt32LE(0) !== LFH_SIG) {
    throw new Error(`unzip: bad local header for "${entry.name}"`);
  }
  return entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

/**
 * Reject path traversal and absolute paths before anything touches the filesystem.
 *
 * The archive is uploaded by an authenticated operator, but "trusted user" is not the same as
 * "trusted file" — the zip came from a third party via email, and an entry named
 * `../../etc/whatever` costs nothing to refuse.
 */
function safeJoin(destDir, name) {
  const normalised = name.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) return null;
  const target = path.resolve(destDir, normalised);
  const root = path.resolve(destDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Extract `zipPath` into `destDir`. Returns the files written.
 *
 * `maxBytes` caps the total uncompressed output. Without it a small archive of highly repetitive
 * data can expand to fill the disk, and this runs on the same container that serves the API.
 */
async function extract(zipPath, destDir, { maxBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.statSync(zipPath).size;
    const raw = findEocd(fd, size);
    if (!raw) throw new Error('unzip: not a zip archive (no end-of-central-directory record)');
    const eocd = resolveZip64(fd, size, raw);
    const entries = readCentralDirectory(fd, eocd);
    if (!entries.length) throw new Error('unzip: archive contains no entries');

    const declared = entries.reduce((sum, e) => sum + (e.uncompressedSize || 0), 0);
    if (declared > maxBytes) {
      throw new Error(
        `unzip: archive expands to ${(declared / 1e6).toFixed(0)} MB, over the ${(maxBytes / 1e6).toFixed(0)} MB limit`
      );
    }

    fs.mkdirSync(destDir, { recursive: true });
    const written = [];

    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      if (entry.name.split('/').includes('__MACOSX')) continue;
      if (path.basename(entry.name).startsWith('._')) continue;

      const target = safeJoin(destDir, entry.name);
      if (!target) throw new Error(`unzip: refusing unsafe entry path "${entry.name}"`);
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`unzip: entry "${entry.name}" uses unsupported compression method ${entry.method}`);
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      const start = dataOffset(fd, entry);
      const source = fs.createReadStream(zipPath, {
        start,
        end: start + entry.compressedSize - 1,
      });
      const sink = fs.createWriteStream(target);

      if (entry.method === 0) await pipeline(source, sink);
      else await pipeline(source, zlib.createInflateRaw(), sink);

      written.push({ name: entry.name, path: target, bytes: fs.statSync(target).size });
    }

    return written;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { extract };
