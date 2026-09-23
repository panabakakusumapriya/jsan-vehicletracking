# How JSAN VTS tracking works (reference for porting to another app)

This document explains, in full technical detail, why background GPS tracking and "auto start
driving detection" work reliably in this app. It is written to hand to another AI/engineer who is
building a similar Android tracker and whose auto-start isn't working. Read it top to bottom —
the reliability comes from several pieces working together, not any single trick.

**Target platform: Android.** (iOS has no equivalent to any of this — Apple does not allow a
persistent foreground service or a `stopWithTask=false` service; iOS tracking uses
`CLLocationManager` significant-location-change / region monitoring instead, which is a
fundamentally different, much weaker mechanism. Everything below is Android-only.)

## 0. The one sentence that matters most

**Recording and uploading GPS happens entirely in native Kotlin code, inside an Android
foreground Service, backed by an on-device SQLite queue — it does NOT depend on JavaScript,
React Native, or the app's UI being alive.** JS is only a remote control that tells the native
service "start" / "stop". Once started, the service runs independently of the JS engine, survives
the JS thread being frozen (Android does this to backgrounded apps), survives the user swiping the
app out of Recents, and survives the OS killing the process outright. This is the single biggest
reason it doesn't lose data — most React Native trackers that "sometimes stop working" are relying
on a JS `setInterval`/background-fetch/expo-location JS task that dies the moment the JS engine is
frozen or the process is killed. This app deliberately avoids that path entirely.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  JS / React Native (LocationContext, bgGeo.ts)                          │
│  - UI, buttons, permission screens, live map marker                     │
│  - Calls VtsTracker.start()/stop() — that's it for recording control    │
│  - Receives "onLocation" events ONLY while app is foreground (cosmetic) │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ Expo Native Module bridge (one-time calls)
┌───────────────────────────▼───────────────────────────────────────────┐
│  Native Android — expo.modules.vtstracker                               │
│                                                                           │
│  TrackingService (foreground Service, stopWithTask=false)               │
│   ├─ FusedLocationProviderClient → GPS fix every ~2-4s / 10m            │
│   ├─ handleLocation(): jitter/teleport guards → SQLite INSERT (sync)    │
│   ├─ every 5s: drain SQLite → POST to backend → delete rows on 2xx      │
│   └─ WatchdogReceiver: AlarmManager tick every 60s, relaunches service  │
│                          if an OEM killed it or GPS callback went dead  │
│                                                                           │
│  AutoStart / AutoStartReceiver (Activity Recognition, "auto mode")      │
│   ├─ Google Play Services detects IN_VEHICLE enter/exit                 │
│   ├─ ENTER → TrackingService.ACTION_AUTO_START → service itself POSTs   │
│   │           /sessions/start over HTTP, THEN starts recording          │
│   └─ EXIT  → 5-min grace, then POSTs /sessions/auto-stop, stops         │
│              (fires even if the app process is dead — OS wakes a        │
│               fresh process just to run the BroadcastReceiver)          │
│                                                                           │
│  BootReceiver — re-arms AutoStart + resumes an active trip after reboot │
│  LocationDb (SQLite) — the durable, native, JS-independent queue        │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 1. Permissions declared and enforced

### 1a. Declared (app.json → merged into AndroidManifest.xml)

```json
"android": {
  "package": "com.pavankumarandroid.jsanvts",
  "permissions": [
    "ACCESS_FINE_LOCATION",
    "ACCESS_COARSE_LOCATION",
    "ACCESS_BACKGROUND_LOCATION",
    "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_LOCATION",
    "WAKE_LOCK",
    "RECEIVE_BOOT_COMPLETED",
    "POST_NOTIFICATIONS",
    "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    "CAMERA",
    "android.permission.ACTIVITY_RECOGNITION"
  ]
}
```

`plugins` config (expo-location) additionally sets:
```json
["expo-location", {
  "locationAlwaysAndWhenInUsePermission": "Allow JSAN VTS to use your location to track your route during driving sessions.",
  "locationAlwaysPermission": "Allow JSAN VTS to track your route during driving sessions - even when app is in background.",
  "locationWhenInUsePermission": "Allow JSAN VTS to show your position on the map and track your route.",
  "isAndroidBackgroundLocationEnabled": true,
  "isAndroidForegroundServiceEnabled": true
}]
```

### 1b. Native module's own manifest (`modules/my-module/android/src/main/AndroidManifest.xml`)
This is merged in by the Expo autolinking/config-plugin system and adds the permissions and
components the native tracker itself needs:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
  <uses-permission android:name="android.permission.WAKE_LOCK" />
  <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
  <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
  <uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
  <uses-permission android:name="com.google.android.gms.permission.ACTIVITY_RECOGNITION" />

  <application>
    <!-- stopWithTask=false is THE key line: the service is NOT killed when the user swipes
         the app out of Recents. Paired with onTaskRemoved() below, which also schedules an
         immediate relaunch alarm in case an OEM kills the process anyway. -->
    <service
      android:name="expo.modules.vtstracker.TrackingService"
      android:enabled="true"
      android:exported="false"
      android:stopWithTask="false"
      android:foregroundServiceType="location" />

    <receiver
      android:name="expo.modules.vtstracker.BootReceiver"
      android:enabled="true"
      android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED" />
        <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
        <action android:name="android.intent.action.QUICKBOOT_POWERON" />
        <!-- App updated from the Play Store also kills the service — resume the trip. -->
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      </intent-filter>
    </receiver>

    <!-- Self-heal watchdog: an AlarmManager alarm relaunches the service if an OEM kills it. -->
    <receiver
      android:name="expo.modules.vtstracker.WatchdogReceiver"
      android:enabled="true"
      android:exported="false" />

    <!-- Auto mode: receives Activity-Recognition IN_VEHICLE enter/exit transitions and
         starts/stops a trip — works even when the app is killed. -->
    <receiver
      android:name="expo.modules.vtstracker.AutoStartReceiver"
      android:enabled="true"
      android:exported="false" />
  </application>
</manifest>
```

### 1c. Why each permission exists

| Permission | Why | If missing |
|---|---|---|
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | GPS fixes at all | Location API throws `SecurityException` |
| `ACCESS_BACKGROUND_LOCATION` | Get fixes with the app backgrounded/closed. On Android 10+ this is a **separate runtime grant** ("Allow all the time" in Settings — the foreground grant alone is not enough) | Fixes stop the moment the app leaves foreground |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` | Required to run a Service the OS won't kill under normal memory pressure. Android 14+ requires the `location` foreground-service *type* to be declared, or `startForeground()` throws `MissingForegroundServiceTypeException` | Service is killed almost immediately in the background |
| `WAKE_LOCK` | Keep the CPU awake while recording so Doze doesn't suspend the location callback thread | Fixes stop firing during deep sleep |
| `RECEIVE_BOOT_COMPLETED` | `BootReceiver` needs this to run after reboot | Trip doesn't resume after a phone restart |
| `SCHEDULE_EXACT_ALARM` | `WatchdogReceiver`'s self-heal alarm needs to fire at precise 60s intervals even in Doze | Watchdog degrades to inexact (can be delayed by OS batching), self-heal weaker |
| `POST_NOTIFICATIONS` (Android 13+) | The foreground service **must** show a persistent notification — without permission, `startForeground()` still works but the user never sees the "recording" indicator | Foreground service is invisible to the driver but still runs; mainly a UX/trust issue |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Lets the app fire the **exact per-app** "Allow X to ignore battery optimization?" system dialog | Falls back to the generic battery-optimization list, which the driver usually skips |
| `ACTIVITY_RECOGNITION` (+ `com.google.android.gms.permission.ACTIVITY_RECOGNITION`) | Required to receive Activity Recognition IN_VEHICLE transitions (Auto Mode) | `requestActivityTransitionUpdates` throws `SecurityException`, auto-start silently never fires |
| `CAMERA` | Unrelated to tracking — used for odometer/plate/lens-check/receipt photos | n/a |

### 1d. How permissions are FORCED (JS side)

Three permissions are **hard gates that block app use entirely**:

1. **App-level gate** (`app/_layout.tsx`): the whole component tree renders a full-screen
   `PermissionsScreen` instead of the app until foreground location + background location +
   notifications are all granted. It re-checks on every `AppState` → `active` transition and on a
   1.5s poll; if any permission is revoked later, the user is bounced back to this screen.
2. **Login gate** (`AuthContext.login`): even after the permission screen passes, login itself
   re-checks foreground+background location and **throws before completing login** if either is
   missing. It also runs a battery-optimization check and blocks with a non-cancelable alert
   ("Go to Settings") if optimization is still on.
3. **Trip-start check** (`LocationContext.startTracking`): re-verifies foreground+background
   location, and — this is the important non-obvious one — **actively re-requests battery
   optimization exemption and offers the exact-per-app system dialog** via
   `IntentLauncher.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', {data: 'package:...'})`,
   not just the generic settings screen. A non-blocking "Start anyway" exists so a trip is never
   un-recordable, but the friction is maximized before that.
4. **Continuous monitoring**: while a trip is active, `startBatteryMonitoring()` polls
   `Battery.isBatteryOptimizationEnabledAsync()` every **15 seconds** and re-alerts the driver
   immediately if optimization gets re-enabled mid-trip (some OEMs silently re-enable it).
5. **OEM-specific nag**: `services/deviceCompatibility.ts` detects the phone manufacturer
   (Xiaomi/Redmi/POCO, Oppo, Realme, Vivo, Huawei, Honor, OnePlus, Samsung, Asus) and — on the
   `PermissionsScreen` — refuses to let the user continue until they tap "Open Settings Now" AND
   then confirm "I've Enabled All" for that OEM's specific auto-start whitelist screen. This one
   is the single most important non-Google-documented reason auto-start clones fail: **stock
   Android APIs cannot prevent Xiaomi/Oppo/Vivo/Huawei from silently killing a background app
   regardless of permissions** — only whitelisting in the OEM's own "Autostart"/"Protected apps"
   settings screen does. If your other app doesn't have this nag screen, that is very likely why
   its auto-tracking silently fails on exactly those brands.
6. **`ACTIVITY_RECOGNITION` for Auto Mode**: only requested when the driver explicitly toggles
   "Auto mode" on (`LocationContext.setAutoStartEnabled`), via `PermissionsAndroid.request(...)`,
   then immediately followed by a battery-optimization exemption request — Auto Mode's own start
   trigger depends on the same battery whitelist as manual tracking, because AR fires a
   `BroadcastReceiver` that starts a Service, and an OEM that kills backgrounded processes can
   also block that broadcast from resulting in a real service start.

---

## 2. The recording engine (manual "Start Trip")

### 2.1 JS side kicks it off (`services/bgGeo.ts`)

```ts
export async function start(sessionId: string, token: string): Promise<void> {
  // Ask to be exempt from battery optimization the moment tracking matters
  try { await VtsTracker.requestIgnoreBatteryOptimizations(); } catch (_) {}
  // ONCE per install, open the manufacturer's Autostart screen (Xiaomi/Oppo/Vivo/Huawei require
  // it for background tracking to survive a swipe-away). Guarded so it isn't shown every trip.
  try {
    if (!(await AsyncStorage.getItem('autostartPrompted_v1'))) {
      await AsyncStorage.setItem('autostartPrompted_v1', '1');
      await VtsTracker.openAutostartSettings();
    }
  } catch (_) {}
  await VtsTracker.start(
    TRACKER_URL,      // e.g. https://api.example.com/api/locations/transistor
    token,             // driver's auth JWT
    sessionId,         // the backend session _id JS already created via POST /sessions/start
    'JSAN VTS — Recording trip',
    'Your route is being recorded for payroll.'
  );
}
```

This is a **one-shot call**. After this, JS's job is done — the native service now owns
everything. `VtsTracker.start(...)` is a thin Expo Native Module `AsyncFunction` that just fires
an `Intent` at the Service:

```kotlin
// VtsTrackerModule.kt
AsyncFunction("start") { url: String, token: String, sessionId: String, title: String, text: String ->
  val ctx = appContext.reactContext ?: throw IllegalStateException("No React context")
  val i = Intent(ctx, TrackingService::class.java).apply {
    action = TrackingService.ACTION_START
    putExtra("url", url); putExtra("token", token); putExtra("session", sessionId)
    putExtra("title", title); putExtra("text", text)
  }
  ContextCompat.startForegroundService(ctx, i)
}
```

### 2.2 The foreground Service takes over (`TrackingService.kt`)

**Location request config** — this exact tuning matters:

```kotlin
val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 4000L)
  .setMinUpdateIntervalMillis(2000L)
  .setMinUpdateDistanceMeters(10f)
  .setWaitForAccurateLocation(false)
  .build()
fused.requestLocationUpdates(req, callback, locThread!!.looper)
```
- Fastest interval 4s, minimum 2s, minimum 10m movement — dense enough for accurate payroll
  distance without draining the battery like a 1s poll would.
- Delivered on a **dedicated `HandlerThread`**, not the main thread — so the synchronous SQLite
  write below never blocks UI or risks ANR.
- `PRIORITY_HIGH_ACCURACY` + FusedLocationProviderClient (Google Play Services), not the raw
  `LocationManager` GPS provider — Fused blends GPS/Wi-Fi/cell and degrades gracefully instead of
  going silent.

**Every fix goes through jitter/teleport guards, then a SYNCHRONOUS SQLite write:**

```kotlin
private fun handleLocation(loc: Location) {
  ...
  if (acc > MAX_ACCURACY_M) return                     // MAX_ACCURACY_M = 100.0 — lenient on purpose;
                                                          // background/Doze fixes are naturally coarser,
                                                          // and a tight gate here silently drops most
                                                          // background points, making the track look cut.
  // GUARD 1 — teleport spike: impossible speed between two close-in-time fixes = GPS noise, drop it
  if (dtSec in 0.0..60.0 && moved / dtSec > MAX_SPEED_MPS) return   // MAX_SPEED_MPS = 60.0 m/s

  // GUARD 2 — stationary jitter: parked car still "wanders" inside GPS accuracy radius;
  // keep ONE point per 30s while stationary instead of a jitter snake
  if (stationary) { if (recentlySaved) return }

  // (1) Persist NATIVELY + SYNCHRONOUSLY — no window where a kill could lose this point
  db.insert(loc.latitude, loc.longitude, acc, spd, hdg, alt, ts, session, gap)

  // (2) Live UI event — ONLY if app is foreground (see LocationBus note below)
  if (LocationBus.foreground) { mainHandler.post { /* emit onLocation to JS */ } }
}
```

Key design decisions to copy:
- **Insert happens on the location callback thread, synchronously, before anything else.** There
  is no `setTimeout`/debounce/batch-in-memory step that could lose points if the process dies
  between "got fix" and "wrote it somewhere durable."
  - **Retry once** on insert failure before giving up and logging (never silently swallow a lost
    point).
- **The UI event bus (`LocationBus`) is gated on foreground state** and is completely decoupled
  from recording. This is critical: if you push every fix to JS via an event emitter unconditionally, and JS is frozen in the background,
  those events queue up in the native→JS bridge and then **flood the JS thread on resume**,
  which is a common cause of "app not responding" / a UI thread stall when you re-open a
  RN tracking app after driving — recording continues fine but the app appears to hang. Gating
  the emit on `LocationBus.foreground` (flipped by `OnActivityEntersForeground`/
  `OnActivityEntersBackground` module hooks) avoids this entirely.

### 2.3 The upload loop — durable queue drain every 5 seconds

```kotlin
private fun ensureUploader() {
  uploader = Executors.newSingleThreadScheduledExecutor()
  uploader!!.scheduleWithFixedDelay({ maybeAutoStop(); uploadOnce() }, 3, 5, TimeUnit.SECONDS)
}

private fun uploadOnce() {
  if (!uploading.compareAndSet(false, true)) return   // serialized — never two concurrent drains
  try {
    while (true) {
      val rows = db.unsynced(BATCH)                    // BATCH = 100
      if (rows.isEmpty()) break
      val group = rows.takeWhile { it.session == rows[0].session }  // one session per POST
      val body = /* build {location:[...], sessionId} JSON */
      if (postBatch(body)) db.deleteIds(group.map { it.id })  // delete ONLY on HTTP 2xx
      else break                                        // offline/5xx → keep rows, retry next tick
    }
  } finally { uploading.set(false) }
}
```
- Plain `HttpURLConnection`, no retry library, no dependency — deliberately simple and impossible
  to misconfigure.
- **Delete-on-2xx-only** is the whole reliability story for uploads: a point is only ever removed
  from the device once the server has it. Offline for 6 hours → queue just grows and drains fully
  once connectivity returns. Nothing is lost, nothing is duplicated (rows are deleted by primary
  key right after a successful POST of that exact set).
- Backend endpoint: `POST /api/locations/transistor` with body
  `{ location: [{coords:{latitude,longitude,accuracy,speed,heading,altitude}, timestamp, hasGapBefore}, ...], sessionId }`.
  2xx → delete locally; anything else → keep and retry in 5s.

### 2.4 Surviving app-kill: `stopWithTask="false"` + `onTaskRemoved` + the Watchdog

This is the part most homegrown trackers get wrong. Three independent layers, each catching what
the previous one might miss:

**Layer 1 — manifest flag.** `android:stopWithTask="false"` tells Android: when the user swipes
this app's task out of Recents, do **not** kill this Service along with it. Without this single
line, swiping the app away kills the Service immediately regardless of anything else you do.

**Layer 2 — `onTaskRemoved()` schedules an immediate relaunch alarm anyway**, because on
aggressive OEMs the process can still be killed shortly after task removal even with
`stopWithTask=false`:

```kotlin
override fun onTaskRemoved(rootIntent: Intent?) {
  if (prefs().getBoolean("active", false)) {
    WatchdogReceiver.restartSoon(this)   // AlarmManager alarm ~1.5s out, survives process death
    WatchdogReceiver.schedule(this)      // re-arm the normal 60s self-heal chain too
  }
  super.onTaskRemoved(rootIntent)
}

override fun onDestroy() {
  // Belt-and-braces: if we're being destroyed while a trip is still active (OEM kill / low
  // memory), the alarm — which lives in AlarmManager, not our process — relaunches us anyway.
  if (isRunning && prefs().getBoolean("active", false)) WatchdogReceiver.restartSoon(this)
  super.onDestroy()
}
```
The key insight: **the relaunch alarm is registered with `AlarmManager`, a system service, not
held in the app's process.** So even if the OS kills the entire app process a moment later, the
alarm still fires (in a **fresh** process Android spins up just to deliver it) and restarts the
Service via `ACTION_START` (which `onStartCommand` handles by reloading persisted config from
`SharedPreferences` and calling `beginRecording()` again — fully idempotent).

**Layer 3 — the recurring Watchdog** (`WatchdogReceiver.kt`) is the single biggest reliability
win, worth calling out on its own:

```kotlin
class WatchdogReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (!prefs.getBoolean("active", false)) return   // tracking stopped → don't restart, don't re-arm

    if (!TrackingService.isRunning) {
      restart()   // service was killed (OEM / Doze / low-memory) → relaunch it
    } else {
      // Alive, but has GPS gone silent? (OEM froze the fused callback, or user toggled Location off/on)
      val lastFixTs = prefs.getLong("lastFixTs", 0L)
      if (lastFixTs > 0L && System.currentTimeMillis() - lastFixTs > STALE_FIX_MS /* 3 min */) restart()
    }
    schedule(context)  // re-arm the next 60s tick — exact alarms don't repeat, so each tick re-schedules itself
  }
}
```
- Fires every **60 seconds** via `AlarmManager.setExactAndAllowWhileIdle` (falls back to
  `setAndAllowWhileIdle` if exact-alarm permission was revoked) — `AndAllowWhileIdle` variants
  fire even during Doze, which a plain alarm would not.
- Two independent failure modes checked: (a) **is the Service process even alive** (`isRunning`
  static flag), and (b) **is it alive but the GPS callback gone stale** (no `lastFixTs` update in
  3 minutes while a trip is supposedly active — this catches OEMs that freeze the location
  callback without killing the process outright). Re-sending `ACTION_START` is safe either way
  because `requestLocationUpdates` is idempotent — it just re-subscribes.
- Started from `beginRecording()` and re-armed on **every** tick, task-removal, and service
  destroy — the chain is self-perpetuating for as long as `prefs["active"] == true`, and stops
  cleanly the moment `stopTracking()` sets `active = false` (the next tick sees that and does not
  re-arm, letting the alarm chain die naturally).

**Layer 4 — reboot / app-update recovery** (`BootReceiver.kt`):
```kotlin
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (a == BOOT_COMPLETED || a == LOCKED_BOOT_COMPLETED || a == MY_PACKAGE_REPLACED || a == QUICKBOOT_POWERON) {
      AutoStart.rearmIfEnabled(ctx)   // AR transition registrations don't survive reboot/update
      if (prefs.getBoolean("active", false)) {
        ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java).apply { action = ACTION_START })
      }
    }
  }
}
```
Covers both a genuine device reboot **and** a Play Store auto-update (`MY_PACKAGE_REPLACED`),
both of which kill the running service — a trip that was active before either event resumes
without the driver ever knowing it happened.

### 2.5 Why config survives all of this: SharedPreferences, not memory

Every piece of mutable state the Service needs to resume (`url`, `token`, `session`, `title`,
`text`, `lastFixTs`, `active`) is written to `SharedPreferences("vts_tracker")` on every change,
not just held in Kotlin fields. `onCreate()` and `loadConfig(intent)` both restore from prefs when
the `Intent` carries no extras (i.e. a watchdog/boot/system restart) — so a completely fresh
process, with zero JS involvement, can pick up exactly where it left off.

---

## 3. Auto-start (automatic drive detection) — the part you asked about specifically

**Mechanism: Google Play Services Activity Recognition API, IN_VEHICLE transitions, delivered to
a manifest-registered `BroadcastReceiver` (not a runtime-registered listener).**

This is the detail most homegrown implementations get wrong: they register an Activity
Recognition listener in JS or in an Activity/Service context that only exists while the app
process is alive. This app instead registers with a `PendingIntent.getBroadcast(...)` pointing at
a manifest-declared receiver class — Android will **wake a new process from scratch** to deliver
that broadcast even if the app was completely killed. That's what makes "auto-start even when the
app is swiped away" actually work.

### 3.1 Arming (`AutoStart.kt`)

```kotlin
object AutoStart {
  private fun pendingIntent(ctx: Context): PendingIntent {
    val i = Intent(ctx, AutoStartReceiver::class.java).setAction(ACTION)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    // AR fills the result into the intent → the PendingIntent MUST be MUTABLE on Android 12+,
    // or the OS silently drops the extras and your receiver gets an empty intent.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(ctx, REQ, i, flags)
  }

  @SuppressLint("MissingPermission")
  fun enable(ctx: Context, baseUrl: String, token: String) {
    // Persist config FIRST — the receiver has no JS to ask for a token, so the token must
    // already be on disk when a transition fires.
    prefs(ctx).edit()
      .putBoolean("autoEnabled", true)
      .putString("autoBaseUrl", baseUrl.trimEnd('/'))
      .putString("autoToken", token)
      .apply()

    val transitions = listOf(
      ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build(),
      ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build(),
    )
    ActivityRecognition.getClient(ctx)
      .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pendingIntent(ctx))
  }

  fun disable(ctx: Context) {
    prefs(ctx).edit().putBoolean("autoEnabled", false).apply()
    ActivityRecognition.getClient(ctx).removeActivityTransitionUpdates(pendingIntent(ctx))
  }

  /** Re-register after boot / app-update — transition registrations do NOT survive either. */
  fun rearmIfEnabled(ctx: Context) {
    if (!prefs(ctx).getBoolean("autoEnabled", false)) return
    enable(ctx, prefs(ctx).getString("autoBaseUrl", "")!!, prefs(ctx).getString("autoToken", "")!!)
  }
}
```

Called from JS (`LocationContext.tsx`) whenever the driver toggles "Auto mode" on, and whenever
the auth token or the enabled flag changes (so the receiver always has a fresh token):
```ts
useEffect(() => {
  if (autoStartEnabled && isAuthenticated && tokenRef.current) {
    bgGeo.enableAutoStart(API_URL, tokenRef.current);
  } else if (!autoStartEnabled) {
    bgGeo.disableAutoStart();
  }
}, [autoStartEnabled, isAuthenticated, token]);
```

**Pitfalls this avoids** (check these first if your clone's auto-start isn't firing):
1. **`FLAG_MUTABLE` missing on Android 12+.** `ActivityTransitionResult` is delivered by writing
   result data into the `Intent` used to fire the `PendingIntent`. An immutable `PendingIntent`
   (the default if you don't explicitly add `FLAG_MUTABLE`) makes the OS silently refuse to fill
   in that data — your receiver fires with `ActivityTransitionResult.hasResult(intent) == false`
   and does nothing, with no error anywhere.
2. **Registering with a listener callback instead of a manifest-declared broadcast receiver +
   PendingIntent.** A `Task<Void>` success listener or an in-process
   `ActivityRecognitionClient` callback only exists while your process is alive — kill the app and
   the registration effectively becomes unreachable (or is torn down with the process). Using
   `PendingIntent.getBroadcast()` targeting a manifest `<receiver>` is what lets Android relaunch a
   process specifically to deliver the transition.
3. **Forgetting `ACTIVITY_RECOGNITION` permission (or its Play Services alias
   `com.google.android.gms.permission.ACTIVITY_RECOGNITION`)** — `requestActivityTransitionUpdates`
   fails silently (`SecurityException` swallowed) with neither.
4. **Not re-arming on boot/update.** Activity-Recognition transition registrations are **not**
   persisted by Google Play Services across a reboot or an app update — you must re-call
   `requestActivityTransitionUpdates` yourself. This app does it from `BootReceiver` via
   `AutoStart.rearmIfEnabled(ctx)`.
5. **No battery-optimization exemption.** Even with a perfectly-configured
   `ActivityTransitionRequest`, if the OS has killed/frozen the app's whole process footprint on an
   aggressive OEM, the broadcast *can* still be dropped before the receiver's `onReceive` runs, or
   the resulting `startForegroundService()` call can be blocked/delayed enough to matter. This is
   why the manual-start battery-optimization prompt is fired again right after granting
   `ACTIVITY_RECOGNITION` (`LocationContext.setAutoStartEnabled`).

### 3.2 Firing (`AutoStartReceiver.kt`) — starts a session with ZERO JS involvement

```kotlin
class AutoStartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val prefs = context.getSharedPreferences(TrackingService.PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean("autoEnabled", false)) return

    for (event in result.transitionEvents) {
      if (event.activityType != DetectedActivity.IN_VEHICLE) continue
      when (event.transitionType) {
        ACTIVITY_TRANSITION_ENTER -> {
          // Only auto-start if nothing is already recording (don't stomp a manual trip in progress).
          if (!TrackingService.isRunning) {
            val svc = Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_AUTO_START)
            ContextCompat.startForegroundService(context, svc)
          }
        }
        ACTIVITY_TRANSITION_EXIT -> {
          // Only an AUTO-started trip auto-ends; a manual trip is NEVER auto-ended by AR.
          if (TrackingService.isRunning && prefs.getBoolean("autoStarted", false)) {
            val svc = Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_AUTO_EXIT)
            ContextCompat.startForegroundService(context, svc)
          }
        }
      }
    }
  }
}
```

`BroadcastReceiver.onReceive()` runs with a very short execution-time budget (a few seconds) and
**cannot** itself do a blocking network call — so it does the one thing it's allowed: immediately
kick off a Service via `startForegroundService()` and return. Everything slow happens inside the
Service, which is now allowed to run in the background because it promptly calls
`startForeground()`.

### 3.3 The Service creates the backend session itself — no app UI required

This is the part that makes true "app was force-closed, driver just starts driving, trip appears
in the admin panel automatically" auto-start work:

```kotlin
ACTION_AUTO_START -> {
  if (isRunning) return START_STICKY
  startForegroundNotif()   // MUST call within Service.onCreate/onStartCommand — FGS rule
  Thread {
    if (startAutoSession()) {
      mainHandler.post { beginRecording() }
    } else {
      // Offline / expired token / already active elsewhere → stand down; AR fires again next drive.
      mainHandler.post { stopForeground(...); stopSelf() }
    }
  }.start()
  return START_STICKY
}

private fun startAutoSession(): Boolean {
  val baseUrl = prefs.getString("autoBaseUrl", "") ?: return false
  val tk = prefs.getString("autoToken", "") ?: return false
  val sid = httpStartSession(baseUrl, tk) ?: return false     // POST /sessions/start, Bearer tk
  // Persist the resulting session so a subsequent kill/restart resumes THIS trip, not a new one
  prefs.edit().putString("url", "$baseUrl/locations/transistor").putString("token", tk)
    .putString("session", sid).putBoolean("autoStarted", true).apply()
  url = "$baseUrl/locations/transistor"; token = tk; session = sid
  return true
}

private fun httpStartSession(baseUrl: String, tk: String): String? {
  // Plain HttpURLConnection POST /sessions/start with Bearer token, body "{}"
  // Parses the JSON response for `_id` (or `data._id`) and returns it, or null on any failure.
}
```

**Two critical rules baked in:**
- **`startForeground()` must be called within a few seconds of the Service starting** (the
  "foreground service start rule") — so it's called *before* the network thread even begins, using
  a generic "Recording trip" notification; the real title/text load once config is confirmed.
- **The HTTP call to create the session runs on a background `Thread`, never the main thread** —
  the receiver → service → session creation chain never blocks the UI thread anywhere, which
  matters because `startForegroundService()` itself has a short window in which the service must
  respond.

Stopping mirrors this with a 5-minute grace period so a stoplight or brief pedestrian stop doesn't
end the trip:
```kotlin
ACTION_AUTO_EXIT -> {
  startForegroundNotif()
  if (isRunning && prefs.getBoolean("autoStarted", false)) {
    prefs.edit().putLong("autoExitAt", System.currentTimeMillis()).apply()
    return START_STICKY
  }
  stopSelf(); return START_NOT_STICKY
}

// Checked every 5s alongside the upload loop
private fun maybeAutoStop() {
  if (!prefs.getBoolean("autoStarted", false)) return
  val exitAt = prefs.getLong("autoExitAt", 0L)
  if (exitAt <= 0L || System.currentTimeMillis() - exitAt < AUTO_STOP_GRACE_MS /* 5 min */) return
  httpAutoStopSession(baseUrl, tk)   // POST /sessions/auto-stop, Bearer tk
  prefs.edit().remove("autoExitAt").putBoolean("autoStarted", false).apply()
  mainHandler.post { stopTracking() }
}
```
If the driver starts driving again inside those 5 minutes, a fresh `ACTION_AUTO_START` never fires
(because `TrackingService.isRunning` is still true and `AutoStartReceiver` checks that), so the
same trip just continues — no spurious trip-splitting on a red light.

### 3.4 Auto-mode summary sequence

```
Driver starts driving (app may be fully killed)
        │
        ▼
Google Play Services detects IN_VEHICLE (accelerometer+network fusion, NOT GPS-based —
this works even before any location fix)
        │
        ▼
OS delivers ACTIVITY_TRANSITION_ENTER broadcast → wakes AutoStartReceiver in a fresh process
        │
        ▼
AutoStartReceiver: TrackingService.isRunning? No → startForegroundService(ACTION_AUTO_START)
        │
        ▼
TrackingService.onStartCommand(ACTION_AUTO_START):
  1. startForeground() immediately (satisfies FGS rule)
  2. background Thread: POST /sessions/start with stored token → get session _id
  3. beginRecording(): FusedLocationProviderClient subscribe, SQLite queue, 5s upload loop, watchdog armed
        │
        ▼
Driver stops driving → ACTIVITY_TRANSITION_EXIT → ACTION_AUTO_EXIT → 5 min grace timer armed
        │
        ▼
(if no new ENTER within 5 min) next upload-loop tick calls maybeAutoStop():
  POST /sessions/auto-stop, stopTracking()
```

---

## 4. What the JS layer actually does (thin, by design)

`services/bgGeo.ts` is the entire JS-facing API surface — deliberately small:

```ts
start(sessionId, token)                          // fire the Intent, see §2.1
stop()                                            // VtsTracker.stop() → ACTION_STOP
getState()                                        // { enabled: boolean } — is native service running
syncNow()                                         // force an immediate upload drain
pendingCount()                                    // rows still queued on-device (for a "N pending" badge)
isIgnoringBatteryOptimizations()
requestIgnoreBatteryOptimizations()
getReliabilityStatus()                            // native diagnostic snapshot, see below
openAutostartSettings() / openAppDetailsSettings() / openDataUsageSettings() / openExactAlarmSettings()
enableAutoStart(baseUrl, token) / disableAutoStart()
```

`LocationContext.tsx` wires UI state to these calls but **never itself schedules GPS reads** when
`USE_BG_GEO = true` (the flag that makes the native engine the sole recorder — the legacy
`expo-location` JS-side background task exists in the file only as dead/fallback code and is not
the active path). The only thing JS listens for is the cosmetic `onLocation` event (map marker +
live stats), which — as covered in §2.2 — is deliberately silent while backgrounded so it can
never flood the JS thread on resume.

### 4.1 The Reliability Checklist (proactive diagnosis, shown to the driver)

`VtsTrackerModule.getReliabilityStatus()` returns a native snapshot the JS UI turns into a
checklist with one-tap fixes:

```kotlin
AsyncFunction("getReliabilityStatus") {
  mapOf(
    "batteryOptimized" to !pm.isIgnoringBatteryOptimizations(ctx.packageName),
    "powerSaveMode" to pm.isPowerSaveMode,
    "backgroundDataRestricted" to (cm.restrictBackgroundStatus == RESTRICT_BACKGROUND_STATUS_ENABLED),
    "exactAlarmBlocked" to (SDK_INT >= S && !am.canScheduleExactAlarms()),
    "backgroundLocationMissing" to (SDK_INT >= Q &&
      ctx.checkSelfPermission(ACCESS_BACKGROUND_LOCATION) != PERMISSION_GRANTED),
    "manufacturer" to Build.MANUFACTURER
  )
}
```
`services/reliabilityItems.ts` turns this into actionable rows (battery optimization, autostart —
shown only for known-aggressive OEM brands, power-save mode, background data, background
location, exact alarms), each with a native `Intent` "Fix" button
(`openAppDetailsSettings`/`openDataUsageSettings`/`openExactAlarmSettings`/`openAutostartSettings`).
Surfaced in three places: a homepage "Tracking health" card, a full-screen checklist modal, and
automatically popped up the first time a trip starts if anything is wrong.

`openAutostartSettings()` is the OEM auto-start whitelist launcher — tries a list of known
manufacturer component names in order and opens the first one that exists:
```kotlin
val candidates = listOf(
  "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
  "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
  "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",   // Oppo/Realme
  "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",                          // vivo/iQOO
  "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
  "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity",
  // ... (full list in VtsTrackerModule.kt)
)
```
And critically, these settings `Intent`s are launched **from the current foreground Activity**
when one is available, falling back to the app Context + `FLAG_ACTIVITY_NEW_TASK` only if not —
because on MIUI/ColorOS, launching a settings screen from a background/application Context is
silently blocked, which is another classic silent-failure trap.

---

## 5. Checklist to diagnose why your other app's auto-start doesn't work

Compare your implementation against each line:

- [ ] Is GPS recording done in a **native foreground Service with `stopWithTask="false"`**, or
      does it live in JS (`expo-location`'s `startLocationUpdatesAsync` TaskManager task, a
      `setInterval`, a background-fetch task)? If JS-based: the JS engine is frozen by Android
      within seconds of backgrounding on many OEMs, which silently stops everything.
- [ ] Is Activity Recognition registered via **`PendingIntent.getBroadcast()` to a
      manifest-declared `<receiver>`**, or via an in-process listener/callback? The latter dies
      with the process.
- [ ] Is that `PendingIntent` built with **`FLAG_MUTABLE`** on Android 12+ (API 31+)? Without it,
      `ActivityTransitionResult.extractResult()` returns null and nothing happens, silently.
- [ ] Do you have **both** `android.permission.ACTIVITY_RECOGNITION` and
      `com.google.android.gms.permission.ACTIVITY_RECOGNITION` declared, and is the runtime
      permission actually granted (Android 10+ requires the runtime prompt, not just the
      manifest entry)?
- [ ] Do you **re-register** Activity Recognition transitions after boot and after an app update?
      Registrations do not survive either.
- [ ] Does your BroadcastReceiver call `startForegroundService()` **and does the target Service
      call `startForeground()` within the first few seconds**? Missing/late `startForeground()`
      throws `ForegroundServiceStartNotAllowedException` on Android 12+ when triggered from a
      background context (a broadcast receiver counts).
- [ ] Is your recorded-point storage a **synchronous, durable, on-device write** (SQLite/Room)
      that happens on the location-callback thread, or does it sit in an in-memory array/queue
      first? The latter loses everything not yet flushed if the process dies.
- [ ] Do you **delete/ack a point only after a confirmed 2xx from the server**, or do you delete
      optimistically? Optimistic deletes lose data on any network hiccup.
- [ ] Do you have a **recurring AlarmManager watchdog** (not just `START_STICKY`) that checks
      "is my service actually alive, and is it actually still receiving fixes" and relaunches if
      not? `START_STICKY` alone is not honored by MIUI, ColorOS, EMUI, Funtouch OS, or (to a
      lesser extent) One UI under memory pressure or their custom battery managers.
- [ ] Do you request the app be exempted from battery optimization with the **exact per-app
      intent** (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + `package:` data URI), not just sending
      the user to the generic battery settings list?
- [ ] Do you detect the phone's OEM and **force the user through that manufacturer's own
      "Autostart"/"Protected apps"/"Background pop-up"/"App launch management" whitelist screen**
      before letting them proceed? This is not discoverable from stock Android APIs — Xiaomi,
      Oppo, Vivo, Huawei, and Honor all silently kill background apps/services regardless of every
      permission and manifest flag above unless the app is separately whitelisted in their own
      security-center UI. If your app doesn't have this screen, this is very likely your root
      cause on those brands (a huge share of the Android market).
- [ ] Are you launching those OEM settings `Intent`s from the **current foreground Activity**,
      not an application Context? MIUI/ColorOS block Activity launches from a background Context.
- [ ] Are you gating any native→JS live-location event emission on **app foreground state**? If
      not, and you emit every fix unconditionally, the bridge queue floods when JS resumes after
      a long backgrounded drive and the app appears frozen/ANRs — which can look like "tracking
      broke" even though the native recorder never actually stopped.

---

## 6. Backend contract (for completeness)

- `POST /api/sessions/start` — Bearer token, empty body `{}` → `{ _id: "<sessionId>", ... }`.
  Called by JS for manual start, and by the native Service itself (off-thread, no JS) for
  auto-start.
- `POST /api/sessions/auto-stop` — Bearer token, empty body → closes the driver's active session
  with no odometer/photo prompts (those only apply to a manually-ended trip).
- `POST /api/locations/transistor` — Bearer token, body
  `{ location: [{coords:{latitude,longitude,accuracy,speed,heading,altitude}, timestamp: ISO8601, hasGapBefore: boolean}, ...], sessionId }`.
  Returns 2xx on success (any 2xx code is treated as "delete these rows locally"); anything else
  keeps the rows queued for the next 5-second upload tick.

---

## 7. Version/config context (in case behavior differs by SDK version)

- Native module built with Expo Modules API (Kotlin), autolinked as `modules/my-module`.
- `expo-location` config plugin still declares the permissions/manifest entries (see §1a) but its
  own JS-side background task is **not** the active recording path (`USE_BG_GEO = true` in
  `LocationContext.tsx` routes everything through the native module instead) — kept only as a
  documented fallback in git history.
- Foreground service type `location` is required on Android 10+ (`ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION`)
  and enforced strictly from Android 14 onward.
