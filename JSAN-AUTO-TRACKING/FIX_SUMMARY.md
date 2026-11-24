# Signature Mismatch Fix - Deployment Guide

## Problem Fixed
✅ **SignatureDoesNotMatch errors when uploading marker photos to S3**

## Root Cause
The presigned PUT URL was including `ContentType` in the signature, but the phone's HTTP client modifies the Content-Type header (adds charset, etc.), causing the signature to become invalid.

## What Was Changed

### File: `backend/src/config/s3.js`

**Before:**
```javascript
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ 
      Bucket: process.env.S3_BUCKET, 
      Key: key, 
      ContentType: contentType  // ← THIS CAUSED THE PROBLEM
    }),
    { expiresIn }
  );
}
```

**After:**
```javascript
async function presignPut(key, contentType, expiresIn = 15 * 60) {
  const client = getS3Client();
  // ContentType intentionally NOT included in PutObjectCommand - see comment above
  // Including it causes SignatureDoesNotMatch when the phone's fetch layer modifies the header
  return getSignedUrl(
    client,
    new PutObjectCommand({ 
      Bucket: process.env.S3_BUCKET, 
      Key: key 
    }),
    { expiresIn }
  );
}
```

## Why This Works

1. **Without ContentType in signature**: S3 doesn't validate the Content-Type header
2. **Phone can send any Content-Type**: The HTTP client's modifications don't break the signature
3. **Security maintained**: 
   - Link is short-lived (15 minutes)
   - Only authenticated drivers get the link
   - Key includes driver ID and client ID

## Deployment Steps

### 1. Verify the Fix Locally (Optional)
```bash
cd backend
npm test  # If you have tests
```

### 2. Commit and Push
```bash
git add backend/src/config/s3.js
git commit -m "Fix: Remove ContentType from S3 presigned PUT signature

Removes ContentType from presignPut() signature to fix SignatureDoesNotMatch 
errors. Phone's HTTP client modifies Content-Type header which invalidates 
the signature when ContentType is included.

Fixes marker photo upload failures in production."

git push
```

### 3. Deploy to Railway Production

**Option A - Automatic Deploy (if configured):**
Railway will auto-deploy on push to main branch

**Option B - Manual Deploy:**
```bash
cd backend
railway up --environment production
```

**Option C - Via Railway Dashboard:**
1. Go to Railway dashboard
2. Select the backend service
3. Go to Deployments
4. Click "Deploy Now" or trigger from GitHub

### 4. Verify the Fix

After deployment:

1. **Check Railway logs:**
```bash
railway logs --environment production
```

2. **Test marker photo upload:**
   - Open the driver app
   - Drop a marker with photo
   - Check if photo appears in marker details
   - Check backend logs for any SignatureDoesNotMatch errors

3. **Monitor for 10-15 minutes** to ensure photos are uploading successfully

## Expected Results

✅ Marker photos upload successfully  
✅ No more "SignatureDoesNotMatch" errors in logs  
✅ Photos appear in marker details immediately  
✅ Sync tab shows "All synced" for markers with photos  

## Rollback Plan (if needed)

If something goes wrong:

```bash
git revert HEAD
git push
# Railway will auto-deploy the previous version
```

## Notes

- The comment in the code already explained this issue, but the code didn't match the comment
- This was likely a regression from a previous fix attempt
- No app changes needed - only backend change
- Existing markers without photos cannot be retroactively fixed (photos are lost)
- New markers from this point forward will upload photos correctly

## Testing Checklist

After deployment, verify:

- [ ] New markers with photos upload successfully
- [ ] Railway logs show no SignatureDoesNotMatch errors
- [ ] Existing markers without photos (from before fix) still display correctly
- [ ] Multiple photos per marker work (up to MAX_PHOTOS = 3)
- [ ] Offline queue uploads photos when connection restored
- [ ] Admin panel displays marker photos with presigned GET URLs

## Related Files

- `backend/src/config/s3.js` - **CHANGED** (removed ContentType from signature)
- `backend/src/controllers/marker.controller.js` - Uses presignPut() (no changes needed)
- `JSAN-AUTO-TRACKING/src/lib/markerQueue.ts` - Phone upload logic (no changes needed)
- `JSAN-AUTO-TRACKING/src/lib/api.ts` - API client (no changes needed)
