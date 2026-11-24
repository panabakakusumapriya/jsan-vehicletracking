# Signature Mismatch Root Cause Analysis

## Problem
Getting `SignatureDoesNotMatch` errors when uploading marker photos to S3 in production.

## Root Cause Identified

Located in: `backend/src/config/s3.js` - `presignPut()` function

### The Issue

The presigned PUT URL is being generated **WITH** `ContentType` in the signature:

```javascript
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ 
      Bucket: process.env.S3_BUCKET, 
      Key: key, 
      ContentType: contentType  // ← THIS IS THE PROBLEM
    }),
    { expiresIn }
  );
}
```

### Why This Causes SignatureDoesNotMatch

1. **Server generates signature** with `ContentType: 'image/jpeg'`
2. **Phone uploads photo** but the HTTP client modifies the Content-Type header:
   - Adds charset suffix: `image/jpeg; charset=UTF-8`
   - Or uses its own guess for binary content
   - expo/fetch or native Android networking layer rewrites the header
3. **S3 receives different Content-Type** than what was signed → **403 SignatureDoesNotMatch**

## Evidence from Code Comments

There's actually a **detailed comment** in the code that explains this exact issue:

```javascript
/**
 * Content-Type is deliberately NOT part of the signature. Signing it looked tighter — only the
 * exact type the link was issued for would be accepted — but the phone's fetch layer rewrites the
 * header (a charset suffix, or its own guess for a binary body), and the bucket then refuses the
 * PUT with 403 SignatureDoesNotMatch whenever the value differs by even a character. So every photo
 * failed. The link is already short-lived and only handed to an authenticated driver, so accepting
 * whatever Content-Type the phone sends is the safe trade.
 */
```

**However**, the code **DOES NOT MATCH the comment**! The ContentType is still being included in the signature.

## The Fix

### Current (Broken) Code:
```javascript
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ 
      Bucket: process.env.S3_BUCKET, 
      Key: key, 
      ContentType: contentType  // ← Remove this
    }),
    { expiresIn }
  );
}
```

### Fixed Code:
```javascript
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ 
      Bucket: process.env.S3_BUCKET, 
      Key: key
      // ContentType intentionally NOT included - see comment above
    }),
    { expiresIn }
  );
}
```

## Related Code Flow

### 1. Phone Requests Upload URL
**File**: `src/lib/markerQueue.ts` - `uploadPhotos()`

```typescript
// Phone asks for presigned URLs
links = (await apiMarkerPhotoUploads(token, p.clientId, photos.length)).uploads;

// Then uploads each photo
const bytes = await new File(photos[i].file).bytes();
const res = await expoFetch(links[i].url, {
  method: 'PUT',
  headers: { 'Content-Type': links[i].contentType },  // ← Phone TRIES to set this
  body: bytes,
  signal: ctrl.signal,
});
```

### 2. Backend Generates Presigned URL
**File**: `backend/src/controllers/marker.controller.js`

```javascript
exports.photoUploads = asyncHandler(async (req, res) => {
  // ...
  for (let i = 0; i < n; i += 1) {
    const key = photoKey(req.user._id, clientId, i);
    uploads.push({ 
      key, 
      url: await s3.presignPut(key, PHOTO_TYPE),  // ← Calls the broken function
      contentType: PHOTO_TYPE 
    });
  }
  res.json({ uploads, maxPhotos: MAX_PHOTOS });
});
```

### 3. S3 Configuration
**File**: `backend/src/config/s3.js` (the broken file)

## Impact

- **All marker photo uploads fail** with SignatureDoesNotMatch
- Markers are created **without photos** after MAX_PHOTO_ATTEMPTS (10 tries)
- Photos are lost from markers in production
- Error message in logs: "Photo upload refused by storage (403 SignatureDoesNotMatch)"

## Solution Summary

**Remove the `ContentType` parameter from the `PutObjectCommand` in `presignPut()` function.**

The comment already documents WHY this should be done, but the code wasn't updated to match.

## Additional Context

From `src/lib/markerQueue.ts`:
- Photos retry up to `MAX_PHOTO_ATTEMPTS = 10` times
- After 10 failed attempts, the marker is saved WITHOUT photos
- Error stored in `lastProblem` and shown on Sync tab

## Priority

**CRITICAL** - All marker photos are failing to upload in production.

## Files to Change

1. `backend/src/config/s3.js` - Remove ContentType from presignPut()
