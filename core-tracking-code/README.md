# Core tracking code

Everything that makes JSAN VTS's background GPS tracking + auto-start-when-driving reliable,
extracted from the app into one standalone folder for reuse/porting into another app.

**For the full narrative explanation (why every piece exists, failure modes it avoids, a
line-by-line debugging checklist), read [`how-tracking-works.md`](./how-tracking-works.md) first.**
This README is the "what's in this folder and how to wire it up" reference; that file is the
"why it works" reference.

## Folder contents

```
core-tracking-code/
├── how-tracking-works.md      ← full explainer: architecture, permissions, kill-survival,
│                                 auto-start sequence, SQLite schema, debugging checklist
├── native-module/             ← the Expo Native Module, copied verbatim from
│                                 mobile-app/mobile-app/modules/my-module/
│   ├── LICENSE
│   ├── expo-module.config.json     registers VtsTrackerModule for Android
│   ├── index.ts                     module entry point (re-exports src/)
│   ├── src/
│   │   ├── VtsTrackerModule.ts      TS declaration of the native API surface (JS ↔ native contract)
│   │   ├── VtsTracker.types.ts      VtsLocation / event payload types
│   │   └── VtsTrackerModule.web.ts  no-op web stub (Android-only feature)
│   └── android/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml  permissions + <service>/<receiver> declarations
│           └── java/expo/modules/vtstracker/
│               ├── TrackingService.kt     THE recorder — foreground Service, GPS subscribe,
│               │                          SQLite writes, 5s upload loop, kill-survival logic
│               ├── LocationDb.kt          on-device SQLite queue (source of truth for GPS points)
│               ├── LocationBus.kt         in-process bridge → live map marker (foreground-only)
│               ├── AutoStart.kt           arms/disarms Activity-Recognition IN_VEHICLE detection
│               ├── AutoStartReceiver.kt   receives IN_VEHICLE transitions, starts/stops a trip
│               ├── BootReceiver.kt        resumes an active trip + re-arms auto mode after reboot
│               ├── WatchdogReceiver.kt    60s self-heal alarm — relaunches a killed service
│               └── VtsTrackerModule.kt    JS-facing Expo Module API (start/stop/diagnostics)
└── js-glue/                    ← the JS/TS files that call the native module and enforce
                                   the permissions it depends on
    ├── bgGeo.ts                  thin wrapper around the native module — the ONLY file a
    │                              consuming app should import to drive tracking
    ├── batteryOptimization.ts    battery-optimization detection + the exact per-app exemption intent
    ├── deviceCompatibility.ts    OEM (Xiaomi/Oppo/Vivo/Huawei/…) autostart-killer database + settings launcher
    ├── reliabilityItems.ts       turns native diagnostics into a one-tap-fix checklist
    ├── notificationService.ts    Android notification channel + permission setup
    └── PermissionsScreen.tsx     full-screen gate: blocks app use until location+notifications granted
```

## What's *not* copied here (app-specific, not core to the mechanism)

- `LocationContext.tsx` — the app's React state/UI wiring around `bgGeo.ts` (session recovery,
  live stats, watchdog UI timers). Skipped because it's tightly coupled to this app's screens; the
  *pattern* it follows is documented in `how-tracking-works.md` §4.
- `TrackingHealthCard.tsx` / `ReliabilityChecklist.tsx` — UI components that render
  `reliabilityItems.ts`'s output. Pure presentation, easy to rebuild in your own app's design system.
- Backend routes (`/sessions/start`, `/sessions/auto-stop`, `/locations/transistor`) — see the
  "Backend contract" section below instead; they're a few dozen lines each and specific to this
  app's session/payroll model.

## How to wire this into another Expo/React-Native app

1. **Copy `native-module/`** into your app as `modules/vts-tracker/` (or any name — update the
   package id `expo.modules.vtstracker` throughout if you rename it, including in
   `AndroidManifest.xml`'s `<service>`/`<receiver>` `android:name` attributes and
   `expo-module.config.json`'s `modules` array).
2. **Merge the manifest entries** from `native-module/android/src/main/AndroidManifest.xml` into
   your app's own manifest (Expo autolinking normally does this for you automatically once the
   module is under your app's `modules/` folder — no manual merge needed if you keep it there).
3. **Add the Android permissions** to your `app.json` (`expo.android.permissions`):
   ```json
   [
     "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION",
     "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_LOCATION", "WAKE_LOCK",
     "RECEIVE_BOOT_COMPLETED", "POST_NOTIFICATIONS", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
     "android.permission.ACTIVITY_RECOGNITION"
   ]
   ```
   and configure the `expo-location` plugin with `isAndroidBackgroundLocationEnabled: true` +
   `isAndroidForegroundServiceEnabled: true` (see `how-tracking-works.md` §1a for the exact block).
4. **Copy `js-glue/`** into your app, fixing import paths (`../modules/my-module` → wherever you
   put the native module in step 1).
5. **Gate your app behind `PermissionsScreen.tsx`** (or your own equivalent) before any tracking
   UI renders — see `how-tracking-works.md` §1d for why all three permission checks (app-gate,
   login-gate, trip-start-gate) matter, not just one.
6. **Drive tracking from your own UI using only `bgGeo.ts`'s exports** — never call the native
   module directly. Minimum viable call sequence:
   ```ts
   import * as bgGeo from './js-glue/bgGeo';

   // Manual trip:
   await bgGeo.start(sessionId, authToken);   // your backend already created `sessionId`
   // ...later...
   await bgGeo.stop();

   // Auto mode (optional):
   await bgGeo.enableAutoStart(API_BASE_URL, authToken);  // arms IN_VEHICLE detection
   await bgGeo.disableAutoStart();                         // disarms it
   ```
7. **Implement the three backend endpoints** the native code calls directly over HTTP (see
   "Backend contract" below) — auto mode does not work without these, because the native Service
   creates/closes sessions itself with zero JS involvement when the app is killed.
8. **Point `TRACKER_URL` in `bgGeo.ts`** at your backend's upload endpoint (currently hardcoded to
   `${API_URL}/locations/transistor` — change `API_URL`'s source or the constant directly).

## Backend contract (implement these three endpoints)

| Endpoint | Called by | Body | Response |
|---|---|---|---|
| `POST /sessions/start` | JS (manual start) **and** the native Service itself (auto-start, off-thread, no JS) | `{}` + `Authorization: Bearer <token>` | `{ _id: "<sessionId>", ... }` — native code reads `_id` (or `data._id`) |
| `POST /sessions/auto-stop` | Native Service only, after the 5-minute post-driving grace period | `{}` + `Authorization: Bearer <token>` | any 2xx (native code ignores the body) |
| `POST /locations/transistor` | Native Service, every 5s while points are queued | `{ location: [{ coords: {latitude, longitude, accuracy, speed, heading, altitude}, timestamp: "<ISO8601>", hasGapBefore: boolean }, ...], sessionId }` + `Authorization: Bearer <token>` | **any 2xx** → native code deletes those rows from SQLite; anything else → rows stay queued, retried next 5s tick |

Getting the response contract exactly right matters: the native `postBatch()` treats HTTP status
`200..299` as "safe to delete," full stop — it does not parse the response body to decide.

## Non-negotiables if you rename/refactor this

These are the specific lines that make the reliability guarantees hold — if you rewrite this
code instead of copying it, keep these exactly:

- `android:stopWithTask="false"` on the `<service>` declaration.
- `PendingIntent.FLAG_MUTABLE` on the Activity-Recognition `PendingIntent` (Android 12+/API 31+)
  — omitting it makes `ActivityTransitionResult.extractResult()` silently return null.
- Activity-Recognition registered via `PendingIntent.getBroadcast()` to a **manifest-declared**
  `<receiver>`, never an in-process listener.
- `startForeground()` called within the first couple seconds of every `onStartCommand()` path
  (manual start, auto-start, watchdog restart, boot restart) — required by the Android 12+
  foreground-service-start rules, and doubly required when the trigger is a `BroadcastReceiver`.
- SQLite `insert()` happens synchronously on the location-callback thread, never buffered in
  memory first.
- SQLite `deleteIds()` is called **only** after an HTTP 2xx for that exact batch — never
  optimistically.
- The `WatchdogReceiver` alarm is scheduled via `AlarmManager`, not `Handler.postDelayed` or a
  coroutine `delay()` — it must survive the hosting process being killed.

Full rationale for every one of these lives in `how-tracking-works.md`.
