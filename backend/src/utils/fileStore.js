const crypto = require('crypto');
const fs = require('fs');
const { PassThrough, pipeline } = require('stream');
const { promisify } = require('util');
const mongoose = require('mongoose');

const pipe = promisify(pipeline);

/**
 * Durable storage for uploaded files, backed by GridFS.
 *
 * Uploads used to be streamed to `os.tmpdir()` and read back by the background import runner. That
 * works on a laptop and fails on the platform this actually runs on: Railway containers have an
 * EPHEMERAL filesystem. Any redeploy, restart, or crash wipes /tmp, and if more than one replica is
 * running the upload can land on one container while the runner reads from another. Either way the
 * job fails with "the uploaded archive is no longer on disk" — after the operator has already spent
 * minutes pushing 80 MB up a mobile-grade connection.
 *
 * GridFS was chosen over object storage because MongoDB is already here: no new service, no new
 * credentials, no new failure mode, and it inherits the database's durability and backups. The
 * customer's original delivery is a thing we promised not to lose, so it belongs somewhere that
 * survives a deploy.
 *
 * Local disk is still used, but only as a CACHE — see networkImport.extractLayer, which
 * re-materialises the file from here whenever the cached copy has gone.
 */

const BUCKET = 'importUploads';

function bucket() {
  const db = mongoose.connection?.db;
  if (!db) throw new Error('fileStore: no database connection');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
}

/**
 * Stream `source` into GridFS, hashing as it passes through.
 *
 * The hash is computed on the way past rather than by re-reading the stored file: these are up to
 * ~100 MB and reading them twice on an already slow container is pure latency.
 */
async function putStream(source, { filename, metadata = {} } = {}) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const tap = new PassThrough();
  tap.on('data', (chunk) => {
    hash.update(chunk);
    // Counted here rather than read off the write stream afterwards: `length` on the driver's
    // GridFS write stream is an implementation detail, and an empty upload has to be detectable.
    bytes += chunk.length;
  });

  const upload = bucket().openUploadStream(filename, { metadata });
  const finished = new Promise((resolve, reject) => {
    upload.on('error', reject);
    upload.on('finish', resolve);
  });

  await pipe(source, tap, upload);
  await finished;

  return { id: upload.id, filename, bytes, sha256: hash.digest('hex') };
}

/** Write a stored file back out to `destPath`. Used to repopulate the on-disk cache. */
async function downloadTo(id, destPath) {
  await pipe(bucket().openDownloadStream(toObjectId(id)), fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
}

async function exists(id) {
  if (!id) return false;
  try {
    const found = await bucket().find({ _id: toObjectId(id) }, { limit: 1 }).toArray();
    return found.length > 0;
  } catch {
    return false;
  }
}

/**
 * Permanently remove a stored file. Only ever called from an explicit user-initiated delete — the
 * artifact sweep deliberately does NOT touch these, because they are the customer's originals.
 */
async function remove(id) {
  if (!id) return;
  try {
    await bucket().delete(toObjectId(id));
  } catch {
    /* already gone, or never stored */
  }
}

function toObjectId(id) {
  return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;
}

module.exports = { putStream, downloadTo, exists, remove, BUCKET };
