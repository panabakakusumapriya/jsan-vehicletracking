# JSAN Auto-Tracking — Driver App (Expo + native Kotlin engine)

Install-once driver app. The driver logs in **once**; a native Android foreground
service then tracks trips **automatically** with no manual start/stop, and keeps
running even if the app is closed/killed or the phone reboots.

## How the automatic tracking works

The engine is a dedicated **Kotlin module** (`modules/vehicle-tracker/`), not JS —
because when the app is killed the JS runtime dies, so buffering + upload must be native.

| Rule                                   | Where |
|----------------------------------------|-------|
| Auto-**start** a trip at **≥ 5 km/h**  | `TrackingService` state machine |
| Auto-**stop** at speed ~0 (60s grace)  | `TrackingService` (`STOP_GRACE_MS`) |
| **20-min** no-movement → back off; restart on next movement | idle timeout + `ActivityTransitionReceiver` |
| Survive app kill / swipe-away          | `START_STICKY` foreground service |
| Survive reboot                         | `BootReceiver` (`BOOT_COMPLETED`) |
| Offline → buffer, online → upload → delete local | native SQLite (`LocationDatabase`) + `Uploader` (OkHttp) |
| Location fix cadence                    | every 10s (`LOCATION_INTERVAL_MS`) |

Each fix → `LocationDatabase` (SQLite) → `Uploader` POSTs to `POST /api/tracking/ingest`
with the driver's JWT. The server acks stored `clientId`s and the app deletes exactly
those rows. Fully idempotent, safe to retry.

## Prerequisites

- Node 18+, the backend running and reachable from the phone.
- **A custom dev build is required** — background location + a native module **cannot run
  in Expo Go**. Use EAS Build (cloud, no local Android SDK needed) or a local Android SDK.

## Configure the backend URL

The app reads `EXPO_PUBLIC_API_URL` (falls back to `http://10.0.2.2:4000`, the emulator's
route to your PC's localhost). For a **physical device**, create `.env` in this folder:

```
EXPO_PUBLIC_API_URL=http://<your-PC-LAN-IP>:4000
```

## Build & run a dev client

Option A — EAS Build (recommended, no local Android SDK):
```bash
cd JSAN-AUTO-TRACKING
npm install
npx eas-cli build --profile development --platform android   # produces an installable .apk
# install the .apk on the device, then:
npx expo start --dev-client
```

Option B — local build (needs Android Studio / SDK):
```bash
cd JSAN-AUTO-TRACKING
npm install
npx expo run:android        # prebuilds native project, compiles the Kotlin module, installs
```

## Try it

1. Log in as the driver (`driver@jsan.local` / `Driver@12345` after `npm run seed` in backend).
2. Grant **Location → "Allow all the time"**, Activity recognition, and Notifications when asked.
3. Home shows **"Ready — auto-tracking on"**. Now just move:
   - Drive/ride above 5 km/h → a trip starts automatically (notification: "Trip started").
   - Stop for ~1 min → the trip ends automatically.
   - Turn off Wi-Fi/data → points buffer locally ("Queued offline" climbs); turn it back on →
     they upload and the counter drops to 0.
4. Watch them arrive live in the admin panel (Pass 3) or via `GET /api/tracking/live`.

## Permissions requested

`ACCESS_FINE/COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `ACTIVITY_RECOGNITION`,
`FOREGROUND_SERVICE(_LOCATION)`, `RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`, `INTERNET`
(declared in `app.json` + the module's `AndroidManifest.xml`).

## Verified so far
- ✅ TypeScript typecheck (`npx tsc --noEmit`)
- ✅ `expo-doctor` 18/18
- ✅ Native module discovered by Expo autolinking
- ⏳ On-device runtime (auto start/stop, kill-survival) — requires a dev build on a physical
  Android device; cannot be exercised in a headless environment.
