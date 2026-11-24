# Tigris S3 Storage Configuration

## Environment Variables for Railway

Add these environment variables to your Railway deployment:

```bash
S3_ENDPOINT=https://t3.storageapi.dev
S3_REGION=auto
S3_BUCKET=resilient-burrito-hf-zesk
S3_ACCESS_KEY_ID=tid_KdFeksFVvKoYrGRrQPrsSLIdlSI_slJgvtTBmMmJPeqyDSwEAS
S3_SECRET_ACCESS_KEY=tsec_jjsUXBf0+M4IlqXDJe8vJQOyQBgQuLzKPw+FwVeTuLKKaWpSy9pLMXlQrlRUzL6f62pV6W
```

## Folder Structure

The bucket will now contain two separate folders:

1. **`ssd/`** - For SSD card images (existing functionality)
   - Format: `ssd/{userId}_{timestamp}.{ext}`
   - Example: `ssd/507f1f77bcf86cd799439011_1732456789123.jpg`

2. **`markers/`** - For marker photos from drivers (new functionality)
   - Format: `markers/{driverId}/{clientId}/{n}.jpg`
   - Example: `markers/507f1f77bcf86cd799439011/abc123xyz/0.jpg`

## Code Changes Made

### Updated `backend/src/config/s3.js`

- Modified the `uploadToS3()` function to accept an optional `folder` parameter
- Default folder remains `'ssd'` to maintain backward compatibility
- Now supports: `uploadToS3(buffer, filename, userId, 'markers')`

```javascript
// Old usage (still works - defaults to 'ssd'):
await uploadToS3(buffer, originalName, userId);

// New usage for markers:
await uploadToS3(buffer, originalName, userId, 'markers');
```

### Marker Controller (`backend/src/controllers/marker.controller.js`)

- Already uses the proper `markers/` structure via `photoPrefix()` and `photoKey()` functions
- Generates presigned PUT URLs for direct phone uploads
- Format: `markers/{driverId}/{clientId}/{0-2}.jpg`
- Up to 3 photos per marker

### SSDS Controller (`backend/src/controllers/ssds.controller.js`)

- Uses `uploadToS3()` for SSD card images
- Will default to `ssd/` folder (backward compatible)
- No changes needed

## How It Works

1. **SSD Images**: 
   - Uploaded via admin panel
   - Stored in `ssd/` folder
   - Used for equipment tracking

2. **Marker Photos**:
   - Driver presses marker button in app
   - App requests presigned upload URLs from `/api/markers/photo-uploads`
   - App uploads photos directly to S3 at `markers/{driverId}/{clientId}/N.jpg`
   - App then submits marker data with photo keys
   - Photos are viewable via presigned GET URLs (6-hour expiry)

## Security Notes

- Bucket is **private** (not publicly accessible)
- All reads/writes use presigned URLs with expiration
- Presigned PUT URLs expire in 15 minutes
- Presigned GET URLs expire in 6 hours
- Content-Type is intentionally NOT signed to avoid phone header modifications causing signature mismatches

## Testing Checklist

- [ ] Verify Railway has all 5 environment variables set
- [ ] Test SSD image upload (should go to `ssd/` folder)
- [ ] Test marker photo upload (should go to `markers/` folder)
- [ ] Verify photos are viewable in admin panel
- [ ] Check that phone app can upload marker photos successfully
- [ ] Confirm presigned URLs are working (no SignatureDoesNotMatch errors)

## Rollback Plan

If issues occur, the code change is backward compatible. Simply:
1. Revert `backend/src/config/s3.js` to previous version
2. Keep environment variables (they won't break anything)
3. SSD uploads will continue to work as before
