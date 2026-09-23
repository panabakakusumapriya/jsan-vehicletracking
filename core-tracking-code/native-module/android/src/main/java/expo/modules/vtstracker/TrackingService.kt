package expo.modules.vtstracker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native foreground service: the SW-Maps-style recorder. Owns the GPS subscription and an
 * on-device SQLite queue. On every fix it (1) writes to SQLite SYNCHRONOUSLY on a background
 * thread — so there is no window in which a kill could drop a point — (2) pushes a live event
 * to the UI if the app is alive, and (3) a 5s loop uploads the queue to the backend, deleting
 * rows only on HTTP 2xx. Runs whether the app is open, minimized, or swiped closed; START_STICKY
 * + BootReceiver bring it back after a kill or reboot. Payroll-grade: a point is never lost.
 */
class TrackingService : Service() {

  private lateinit var fused: FusedLocationProviderClient
  private lateinit var db: LocationDb
  private val mainHandler = Handler(Looper.getMainLooper())
  private var locThread: HandlerThread? = null
  private var uploader: ScheduledExecutorService? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var providerReceiver: BroadcastReceiver? = null
  private val uploading = AtomicBoolean(false)
  // Confined to the single uploader thread → safe to reuse (no per-row allocation).
  private val uploadSdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  private var url = ""
  private var token = ""
  private var session = ""
  private var title = "Recording trip"
  private var text = "Your route is being recorded."
  // Timestamp of the previous recorded fix — used to flag gaps (GPS loss / app killed while
  // driving), so distance isn't counted across a teleport and tracks/exports break correctly.
  @Volatile private var lastFixTs = 0L
  // Last RECORDED point + last stationary-keep time — used by the on-device jitter guards.
  @Volatile private var lastLat = Double.NaN
  @Volatile private var lastLng = Double.NaN
  @Volatile private var lastIdleSavedTs = 0L

  private val callback = object : LocationCallback() {
    override fun onLocationResult(result: LocationResult) {
      for (loc in result.locations) handleLocation(loc)
    }
  }

  override fun onCreate() {
    super.onCreate()
    fused = LocationServices.getFusedLocationProviderClient(this)
    db = LocationDb(this)
    // Restore session + last-fix so a system/boot restart keeps attributing + flagging correctly.
    val p = prefs()
    session = p.getString("session", "") ?: ""
    lastFixTs = p.getLong("lastFixTs", 0L)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> { stopTracking(); return START_NOT_STICKY }
      ACTION_SYNC -> {
        if (isRunning) Thread { uploadOnce() }.start()
        return if (isRunning) START_STICKY else START_NOT_STICKY
      }
      ACTION_AUTO_START -> {
        // AUTO MODE: the user started driving (Activity Recognition) — possibly with NO JS running
        // (app swiped/killed). We MUST call startForeground() right away (FGS rule), then create
        // the backend session over HTTP off the main thread, then begin recording.
        if (isRunning) return START_STICKY
        startForegroundNotif()
        Thread {
          if (startAutoSession()) {
            mainHandler.post { beginRecording() }
          } else {
            // Offline / expired token / already-active → stand down; AR fires again next drive.
            mainHandler.post {
              try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
              stopSelf()
            }
          }
        }.start()
        return START_STICKY
      }
      ACTION_AUTO_EXIT -> {
        // Stopped driving — arm the auto-stop countdown (the uploader loop closes the trip after
        // the grace if no new drive begins). startForeground to satisfy the FGS-start rule.
        startForegroundNotif()
        if (isRunning && prefs().getBoolean("autoStarted", false)) {
          prefs().edit().putLong("autoExitAt", System.currentTimeMillis()).apply()
          return START_STICKY
        }
        // Trip already ended between the receiver's check and this delivery (or system redelivery)
        // — without recording there is no uploader tick to ever stop us, so a STICKY return here
        // would leave a ZOMBIE "tracking" notification burning battery until reboot. Stand down.
        try { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
        stopSelf()
        return START_NOT_STICKY
      }
    }
    // ACTION_START (or a null-intent restart by the system after a kill).
    loadConfig(intent)
    beginRecording()
    return START_STICKY
  }

  /** Common "start recording" steps shared by manual start, auto start, and system restarts. */
  private fun beginRecording() {
    startForegroundNotif()
    startLocationUpdates()
    registerProviderReceiver()
    ensureUploader()
    acquireWake()
    persistActive(true)
    isRunning = true
    WatchdogReceiver.schedule(this) // self-heal: relaunch us if an OEM kills the service
  }

  /** Runs on the dedicated location thread — the SQLite write below is SYNCHRONOUS. */
  private fun handleLocation(loc: Location) {
    val ts = if (loc.time > 0) loc.time else System.currentTimeMillis()
    val acc = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0
    val spd = if (loc.hasSpeed()) loc.speed.toDouble() else 0.0   // m/s
    val hdg = if (loc.hasBearing()) loc.bearing.toDouble() else 0.0
    val alt = if (loc.hasAltitude()) loc.altitude else 0.0

    // Drop only GARBAGE fixes (acc == 0.0 means "accuracy unknown" → kept). The gate is
    // deliberately LENIENT: in the background / Doze, Android deprioritises GPS and returns
    // coarser fixes (50-100m is normal), so a tight gate here silently drops most background
    // fixes and the track looks "cut". The server applies a tighter gate + road-snap downstream,
    // so a coarse point costs nothing here but keeps the recorded track continuous.
    if (acc > MAX_ACCURACY_M) return

    // Time + straight-line displacement since the last RECORDED point — drives the jitter guards.
    val dtSec = if (lastFixTs > 0L) (ts - lastFixTs) / 1000.0 else Double.MAX_VALUE
    val moved = if (!lastLat.isNaN() && !lastLng.isNaN())
      distanceMeters(lastLat, lastLng, loc.latitude, loc.longitude) else Double.MAX_VALUE

    // GUARD 1 — teleport spike. A closely-spaced fix implying an impossible speed is GPS noise.
    // Dropping it kills the dramatic zig-zag "snake" AND prevents distance OVER-count. NOT applied
    // across a real gap (dt > 60s), where a large jump (tunnel / app was killed) is legitimate.
    if (dtSec in 0.0..60.0 && moved / dtSec > MAX_SPEED_MPS) return

    // GUARD 2 — stationary jitter. When parked (slow AND barely moved) GPS still wanders inside
    // its accuracy radius, drawing a snake cluster at every stop. Keep ONE point per 30s so the
    // timeline stays continuous for payroll, but drop the in-between jitter.
    val stationary = spd < STILL_SPEED_MPS && moved < STILL_MOVE_M && !lastLat.isNaN()
    if (stationary) {
      if (lastIdleSavedTs > 0L && ts - lastIdleSavedTs < IDLE_KEEP_MS) return
      lastIdleSavedTs = ts
    } else {
      lastIdleSavedTs = 0L
    }

    // Flag a gap if there was a long pause since the last fix (GPS loss / app killed mid-drive).
    val gap = if (lastFixTs > 0L && ts - lastFixTs > GAP_MS) 1 else 0

    // (1) Persist natively + synchronously — no window in which this point could be lost.
    // Retry once on failure (transient lock), and DON'T swallow silently: a dropped insert is a
    // lost payroll point, so log it + warn the driver via the notification so it can be flagged.
    var inserted = false
    try { db.insert(loc.latitude, loc.longitude, acc, spd, hdg, alt, ts, session, gap); inserted = true }
    catch (e1: Throwable) {
      try { db.insert(loc.latitude, loc.longitude, acc, spd, hdg, alt, ts, session, gap); inserted = true }
      catch (e2: Throwable) {
        android.util.Log.e("VtsTracker", "GPS point NOT stored (storage full?): ${e2.message}")
      }
    }
    if (!inserted) return // don't advance state / emit as if recorded

    // Advance "last recorded" state ONLY after a successful insert (so a failed write doesn't
    // wrongly suppress the next gap flag or move the jitter reference point).
    lastFixTs = ts
    lastLat = loc.latitude
    lastLng = loc.longitude
    prefs().edit().putLong("lastFixTs", ts).apply()

    // (2) Live event to the UI — ONLY while the app is in the foreground. While backgrounded the
    // OS can freeze the JS thread; emitting then would queue native→JS calls that flood the JS
    // thread on resume → "Not responding". Recording/upload above never depend on this.
    if (LocationBus.foreground) {
      mainHandler.post {
        val coords = mapOf(
          "latitude" to loc.latitude, "longitude" to loc.longitude, "accuracy" to acc,
          "speed" to spd, "heading" to hdg, "altitude" to alt
        )
        LocationBus.listener?.invoke(mapOf("coords" to coords, "timestamp" to ts))
      }
    }
  }

  /** Haversine distance in metres — used by the on-device jitter guards. */
  private fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
    val r = 6371000.0
    val dLat = Math.toRadians(lat2 - lat1)
    val dLng = Math.toRadians(lng2 - lng1)
    val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }

  /**
   * Drain the on-device queue to the backend. Serialized (no concurrent runs → no double-POST)
   * and fully drains in one call. Each batch is the leading run of points that share a session,
   * uploaded with THAT session id, so points are always attributed to the trip they belong to.
   * Rows are deleted locally ONLY on HTTP 2xx — any failure keeps them for the next cycle, so
   * no GPS point is ever lost.
   */
  private fun uploadOnce() {
    if (url.isEmpty()) return
    if (!uploading.compareAndSet(false, true)) return // already draining
    try {
      while (true) {
        val rows = db.unsynced(BATCH)
        if (rows.isEmpty()) break
        val sess = rows[0].session
        val group = rows.takeWhile { it.session == sess }

        val arr = JSONArray()
        for (r in group) {
          val coords = JSONObject()
            .put("latitude", r.lat).put("longitude", r.lng).put("accuracy", r.acc)
            .put("speed", r.spd).put("heading", r.hdg).put("altitude", r.alt)
          arr.put(
            JSONObject()
              .put("coords", coords)
              .put("timestamp", iso(r.ts))
              .put("hasGapBefore", r.gap == 1)
          )
        }
        val body = JSONObject().put("location", arr).put("sessionId", sess).toString()

        if (postBatch(body)) {
          db.deleteIds(group.map { it.id })
        } else {
          break // non-2xx / offline → keep rows, retry on the next 5s cycle
        }
      }
    } catch (_: Throwable) {
      // Network/host failure → keep the rows; retry next cycle. Nothing lost.
    } finally {
      uploading.set(false)
    }
  }

  /** POST one batch. Returns true only on HTTP 2xx (the signal to delete locally). */
  private fun postBatch(body: String): Boolean {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(url).openConnection() as HttpURLConnection)
      conn.requestMethod = "POST"
      conn.connectTimeout = 30000
      conn.readTimeout = 60000
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.doOutput = true
      conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val code = conn.responseCode
      try { conn.inputStream?.close() } catch (_: Throwable) { try { conn.errorStream?.close() } catch (_: Throwable) {} }
      code in 200..299
    } catch (_: Throwable) {
      false
    } finally {
      try { conn?.disconnect() } catch (_: Throwable) {}
    }
  }

  /**
   * AUTO MODE — create a backend session and load it into config so recording can begin. Returns
   * false (→ stand down) on offline / expired token / no config. Runs OFF the main thread.
   */
  private fun startAutoSession(): Boolean {
    val p = prefs()
    val baseUrl = p.getString("autoBaseUrl", "") ?: ""
    val tk = p.getString("autoToken", "") ?: ""
    if (baseUrl.isEmpty() || tk.isEmpty()) return false
    val sid = httpStartSession(baseUrl, tk) ?: return false
    val uploadUrl = "$baseUrl/locations/transistor"
    p.edit()
      .putString("url", uploadUrl).putString("token", tk).putString("session", sid)
      .putBoolean("autoStarted", true).remove("autoExitAt").putLong("lastFixTs", 0L)
      .apply()
    url = uploadUrl; token = tk; session = sid
    lastFixTs = 0L; lastLat = Double.NaN; lastLng = Double.NaN; lastIdleSavedTs = 0L
    return true
  }

  /** POST /sessions/start with the stored token → returns the new session id, or null on failure. */
  private fun httpStartSession(baseUrl: String, tk: String): String? {
    var conn: HttpURLConnection? = null
    return try {
      conn = (URL("$baseUrl/sessions/start").openConnection() as HttpURLConnection)
      conn.requestMethod = "POST"
      conn.connectTimeout = 20000; conn.readTimeout = 30000
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Authorization", "Bearer $tk")
      conn.doOutput = true
      conn.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
      if (conn.responseCode !in 200..299) { try { conn.errorStream?.close() } catch (_: Throwable) {}; return null }
      val body = conn.inputStream.bufferedReader().use { it.readText() }
      val json = JSONObject(body)
      val id = if (json.has("_id")) json.optString("_id", "")
        else json.optJSONObject("data")?.optString("_id", "") ?: ""
      if (id.isNotEmpty()) id else null
    } catch (_: Throwable) { null } finally { try { conn?.disconnect() } catch (_: Throwable) {} }
  }

  /** POST /sessions/auto-stop with the stored token → closes the driver's active session (no photos). */
  private fun httpAutoStopSession(baseUrl: String, tk: String) {
    var conn: HttpURLConnection? = null
    try {
      conn = (URL("$baseUrl/sessions/auto-stop").openConnection() as HttpURLConnection)
      conn.requestMethod = "POST"
      conn.connectTimeout = 20000; conn.readTimeout = 30000
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Authorization", "Bearer $tk")
      conn.doOutput = true
      conn.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
      conn.responseCode
      try { conn.inputStream?.close() } catch (_: Throwable) { try { conn.errorStream?.close() } catch (_: Throwable) {} }
    } catch (_: Throwable) {} finally { try { conn?.disconnect() } catch (_: Throwable) {} }
  }

  /** Runs each uploader tick: if an auto-started trip's drive ended (AR EXIT) and the grace has
   *  elapsed, close the session on the backend and stop tracking. Auto mode itself stays armed, so
   *  the next drive auto-starts a fresh trip. */
  private fun maybeAutoStop() {
    val p = prefs()
    if (!p.getBoolean("autoStarted", false)) return
    val exitAt = p.getLong("autoExitAt", 0L)
    if (exitAt <= 0L || System.currentTimeMillis() - exitAt < AUTO_STOP_GRACE_MS) return
    val baseUrl = p.getString("autoBaseUrl", "") ?: ""
    val tk = p.getString("autoToken", "") ?: ""
    if (baseUrl.isNotEmpty() && tk.isNotEmpty()) httpAutoStopSession(baseUrl, tk)
    p.edit().remove("autoExitAt").putBoolean("autoStarted", false).apply()
    mainHandler.post { stopTracking() }
  }

  private fun loadConfig(intent: Intent?) {
    val p = prefs()
    if (intent?.hasExtra("url") == true) {
      url = intent.getStringExtra("url") ?: ""
      token = intent.getStringExtra("token") ?: ""
      val newSession = intent.getStringExtra("session") ?: ""
      title = intent.getStringExtra("title") ?: title
      text = intent.getStringExtra("text") ?: text
      // New trip (session changed) → don't flag the first point as a gap from the old trip,
      // and reset the jitter reference so the first fix of the new trip is never filtered.
      if (newSession != session) { lastFixTs = 0L; lastLat = Double.NaN; lastLng = Double.NaN; lastIdleSavedTs = 0L }
      session = newSession
      p.edit().putString("url", url).putString("token", token).putString("session", session)
        .putString("title", title).putString("text", text).putLong("lastFixTs", lastFixTs).apply()
    } else {
      // Restarted by the system / boot with no extras — restore from prefs (set in onCreate too).
      url = p.getString("url", "") ?: ""
      token = p.getString("token", "") ?: ""
      session = p.getString("session", session) ?: session
      title = p.getString("title", title) ?: title
      text = p.getString("text", text) ?: text
      lastFixTs = p.getLong("lastFixTs", lastFixTs)
    }
  }

  private fun startForegroundNotif() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val ch = NotificationChannel(CHANNEL, "Trip Recording", NotificationManager.IMPORTANCE_LOW)
      ch.setShowBadge(false)
      nm.createNotificationChannel(ch)
    }
    val icon = applicationInfo.icon.let { if (it != 0) it else android.R.drawable.ic_menu_mylocation }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = if (launch != null) {
      PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    } else null
    val notif = NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(icon)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .apply { if (contentIntent != null) setContentIntent(contentIntent) }
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      @Suppress("DEPRECATION")
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun startLocationUpdates() {
    if (locThread == null) locThread = HandlerThread("vts-loc").also { it.start() }
    val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 4000L)
      .setMinUpdateIntervalMillis(2000L)
      .setMinUpdateDistanceMeters(10f)
      .setWaitForAccurateLocation(false)
      .build()
    try {
      // Deliver callbacks on the dedicated thread so the SQLite write can be synchronous + off-main.
      fused.requestLocationUpdates(req, callback, locThread!!.looper)
    } catch (_: SecurityException) {
      // Permission revoked mid-trip — service stays up; updates resume if regranted.
    }
  }

  /**
   * Re-subscribe to location when the user toggles GPS/location services off then on. On some OEMs
   * the fused callback stays dead after a PROVIDERS_CHANGED, so we explicitly re-issue the request
   * when GPS comes back. Registered while recording, unregistered on stop/destroy.
   */
  private fun registerProviderReceiver() {
    if (providerReceiver != null) return
    providerReceiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, i: Intent?) {
        val lm = c?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        val gpsOn = try { lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true } catch (_: Throwable) { false }
        if (gpsOn) {
          try { fused.removeLocationUpdates(callback) } catch (_: Throwable) {}
          startLocationUpdates()
        }
      }
    }
    try { registerReceiver(providerReceiver, IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION)) } catch (_: Throwable) {}
  }

  private fun unregisterProviderReceiver() {
    try { providerReceiver?.let { unregisterReceiver(it) } } catch (_: Throwable) {}
    providerReceiver = null
  }

  private fun ensureUploader() {
    if (uploader == null) {
      uploader = Executors.newSingleThreadScheduledExecutor()
      uploader!!.scheduleWithFixedDelay({ try { maybeAutoStop(); uploadOnce() } catch (_: Throwable) {} }, 3, 5, TimeUnit.SECONDS)
    }
  }

  private fun acquireWake() {
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vts:tracking").apply { setReferenceCounted(false) }
    }
    try { if (wakeLock?.isHeld == false) wakeLock?.acquire(12 * 60 * 60 * 1000L) } catch (_: Throwable) {}
  }

  private fun releaseWake() { try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Throwable) {} }

  private fun stopTracking() {
    isRunning = false
    persistActive(false)
    WatchdogReceiver.cancel(this) // stop the self-heal chain (active=false also stops it)
    unregisterProviderReceiver()
    try { fused.removeLocationUpdates(callback) } catch (_: Throwable) {}
    lastFixTs = 0L; lastLat = Double.NaN; lastLng = Double.NaN; lastIdleSavedTs = 0L
    prefs().edit().remove("lastFixTs").apply()
    Thread { uploadOnce() }.start() // best-effort final flush
    releaseWake()
    uploader?.shutdown(); uploader = null
    locThread?.quitSafely(); locThread = null
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /**
   * The user swiped the app away from recents (or the OS is tearing the task down). For a
   * payroll tracker this must NOT stop recording. We schedule an immediate relaunch alarm — it
   * lives in AlarmManager so it fires in a fresh process even if ours is killed — and re-arm the
   * watchdog chain. Combined with android:stopWithTask="false" + START_STICKY, recording keeps
   * going through a force-close, like a native logger. Only when a trip is actually active.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    try {
      if (prefs().getBoolean("active", false)) {
        WatchdogReceiver.restartSoon(this)
        WatchdogReceiver.schedule(this) // keep the 60s self-heal chain alive too
      }
    } catch (_: Throwable) {}
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseWake()
    unregisterProviderReceiver()
    uploader?.shutdown(); uploader = null
    locThread?.quitSafely(); locThread = null
    // If we're being destroyed while a trip is still active (OEM kill / low memory), make sure
    // we come back. The alarm survives our process death and relaunches the foreground service.
    try { if (isRunning && prefs().getBoolean("active", false)) WatchdogReceiver.restartSoon(this) } catch (_: Throwable) {}
    super.onDestroy()
  }

  private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun persistActive(active: Boolean) { prefs().edit().putBoolean("active", active).apply() }

  private fun iso(ts: Long): String = uploadSdf.format(Date(ts))

  companion object {
    const val ACTION_START = "expo.modules.vtstracker.START"
    const val ACTION_STOP = "expo.modules.vtstracker.STOP"
    const val ACTION_SYNC = "expo.modules.vtstracker.SYNC"
    const val ACTION_AUTO_START = "expo.modules.vtstracker.AUTO_START" // AR detected driving
    const val ACTION_AUTO_EXIT = "expo.modules.vtstracker.AUTO_EXIT"   // AR detected driving ended
    private const val AUTO_STOP_GRACE_MS = 300_000L // 5 min stopped after AR EXIT → auto-end the trip
    const val PREFS = "vts_tracker"
    private const val CHANNEL = "vts_tracking"
    private const val NOTIF_ID = 8423
    private const val BATCH = 100
    private const val GAP_MS = 120_000L // >2 min since last fix = a gap (matches backend stats)
    // Lenient garbage gate. Was 50m, which dropped most BACKGROUND fixes (Doze returns coarse
    // GPS) and made the track look cut. The server road-snaps + gates tighter downstream.
    private const val MAX_ACCURACY_M = 100.0
    private const val MAX_SPEED_MPS = 60.0   // ~216 km/h between fixes = GPS spike → drop (anti-snake)
    private const val STILL_SPEED_MPS = 0.7  // ~2.5 km/h → treat as stopped
    private const val STILL_MOVE_M = 15.0    // ...and moved < 15m → stationary jitter
    private const val IDLE_KEEP_MS = 30_000L // keep 1 stationary point per 30s (continuous timeline)

    @Volatile
    var isRunning = false
  }
}
