const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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

module.exports = { isS3Configured, uploadToS3, getFromS3 };
