const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');

/**
 * S3-compatible storage for SSD card images (Tigris / AWS / any S3-compatible).
 *
 * Required env vars:
 *   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 *   S3_ENDPOINT (for non-AWS, e.g. "https://t3.storageapi.dev")
 *   S3_REGION   (optional, defaults to "auto")
 */

let s3Client = null;

function isS3Configured() {
  return !!(
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );
}

function getS3Client() {
  if (!s3Client && isS3Configured()) {
    const config = {
      region: process.env.S3_REGION || 'auto',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    };
    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT;
      config.forcePathStyle = true;
    }
    s3Client = new S3Client(config);
  }
  return s3Client;
}

/**
 * Upload a buffer to S3. Returns the S3 key (not a full URL).
 */
async function uploadToS3(buffer, originalName, userId) {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;
  const ext = path.extname(originalName) || '.jpg';
  const key = `ssd/${userId}_${Date.now()}${ext}`;

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: `image/${ext.replace('.', '') === 'jpg' ? 'jpeg' : ext.replace('.', '')}`,
  }));

  return key;
}

/**
 * Stream an object from S3 by key. Returns { body (ReadableStream), contentType }.
 */
async function getFromS3(key) {
  const client = getS3Client();
  const bucket = process.env.S3_BUCKET;
  const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return { body: resp.Body, contentType: resp.ContentType || 'image/jpeg' };
}

/**
 * A short-lived link the PHONE uploads one file to, straight into the bucket (marker photos): the
 * bytes never pass through the API.
 *
 * Content-Type is deliberately NOT part of the signature. Signing it looked tighter — only the
 * exact type the link was issued for would be accepted — but the phone's fetch layer rewrites the
 * header (a charset suffix, or its own guess for a binary body), and the bucket then refuses the
 * PUT with 403 SignatureDoesNotMatch whenever the value differs by even a character. So every photo
 * failed. The link is already short-lived and only handed to an authenticated driver, so accepting
 * whatever Content-Type the phone sends is the safe trade.
 */
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  // ContentType intentionally NOT included in PutObjectCommand - see comment above
  // Including it causes SignatureDoesNotMatch when the phone's fetch layer modifies the header
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }),
    { expiresIn }
  );
}

/**
 * A short-lived link to read one object. The bucket is private (an unsigned GET is refused), so
 * this is how the panel and the app show a photo: an <img> cannot carry our Authorization header.
 */
async function presignGet(key, expiresIn = 60 * 60) {
  const client = getS3Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn });
}

/** { bytes, contentType } of an object, or null when it is not there. */
async function headObject(key) {
  const client = getS3Client();
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return { bytes: r.ContentLength ?? null, contentType: r.ContentType || null };
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return null;
    throw e;
  }
}

module.exports = { isS3Configured, uploadToS3, getFromS3, presignPut, presignGet, headObject };
