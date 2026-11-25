# Build Guide - Version 1.0.30
## Marker Photos Optional Update

### Version Info
- **Current Version**: 1.0.30
- **Previous Version**: 1.0.29
- **Change**: Marker photos are now optional (safety & compliance fix)

---

## Build Commands

### Production Build (EAS)

```bash
cd JSAN-AUTO-TRACKING

# Make sure you're logged in to EAS
eas login

# Build for Android (Production)
eas build --platform android --profile production

# Build will take 10-20 minutes
# You'll get a link to download the APK when done
```

### After Build Completes

1. **Download the APK** from the EAS build page
2. **Test on a device** before distributing
3. **Distribute to drivers** via your usual method

---

## Testing Checklist

Before distributing to all drivers, test on a device:

### Marker Functionality
- [ ] Open Map tab
- [ ] Tap marker button (flag icon)
- [ ] Select a color (Red/Yellow/Blue)
- [ ] Place pin on map
- [ ] **NEW**: Try to save WITHOUT adding photos - should work ✅
- [ ] Verify reason is still required
- [ ] Try saving with photos - should still work
- [ ] Check marker appears on map
- [ ] Check marker syncs to backend

### Existing Features (Regression Test)
- [ ] Trip recording still works
- [ ] GPS tracking still works
- [ ] Manual trip start/stop (if applicable)
- [ ] Existing markers still visible
- [ ] Pull-to-refresh still works

---

## Alternative: OTA Update (If Configured)

If you have EAS Updates configured for OTA (Over-The-Air):

```bash
cd JSAN-AUTO-TRACKING

# Publish update without rebuilding
eas update --branch production --message "Photos optional for markers"

# Drivers will get update next time they open app
# No need to redistribute APK
```

**Note**: OTA only works for JavaScript/TypeScript changes (which this is!), so you might be able to use this instead of a full rebuild if EAS Updates is set up.

---

## Check EAS Updates Status

```bash
# See if OTA updates are configured
eas update:list --branch production

# If this works, you can use OTA instead of full rebuild
```

---

## Rollback Plan

If issues occur:

### Option 1: Revert Code
```bash
git checkout HEAD~1 JSAN-AUTO-TRACKING/src/components/MarkerDetailsSheet.tsx
git checkout HEAD~1 JSAN-AUTO-TRACKING/app.json
# Then rebuild
```

### Option 2: Keep Old APK Available
- Keep v1.0.29 APK as backup
- Drivers can reinstall if needed

---

## Communication Template

**Subject**: App Update v1.0.30 - Marker Photos Now Optional

**Message**:
> Hi Team,
> 
> We've released app version 1.0.30 with an important safety improvement:
> 
> **What's New:**
> - Marker photos are now OPTIONAL
> - You can drop markers without stopping to take photos
> - Photos can be added when it's safe to do so
> - Reason for marker is still required
> 
> **Why:**
> - Improves safety - no need to stop vehicle every time
> - Complies with road safety laws
> - Faster marker dropping while driving
> 
> **How to Update:**
> [Include your distribution method - download link, Google Play, etc.]
> 
> Please update your app when convenient.
> 
> Thanks!

---

## Build Time Estimate

- **EAS Cloud Build**: 10-20 minutes
- **OTA Update**: 2-3 minutes
- **Local Build**: 5-10 minutes (if set up)

---

## Questions?

If you encounter issues:
1. Check EAS build logs
2. Test on emulator first
3. Verify all changes committed to git
4. Check environment variables are set
