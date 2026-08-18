package expo.modules.vehicletracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.location.Location
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.roundToInt

/**
 * Distance-based tracking service — same core approach as MyCarTracks.
 *
 * Pipeline per GPS fix:
 *   fix → accuracy gate → distance check → trip state machine → SQLite → upload
 *
 * Trip lifecycle:
 *   IDLE:     watch for 50 m of movement at avg speed ≥ 10 km/h → START trip
 *             (30 m rejects GPS drift; the avg-speed check prevents walking
 *             from starting a trip.)
 *
 *   TRACKING: record a point every 10 m moved from the last recorded point.
 *             High resolution for accurate road-following traces.
 *
 *   END:      no 10 m movement for TRIP_END_NO_MOVE_MS (10 min) → end trip.
 *             Checked by the GPS-independent ticker so it fires even when GPS goes
 *             quiet on a parked vehicle.
 *
 * Why distance instead of speed:
 *   Speed from a single GPS fix is noisy. A parked car can report 2–5 km/h from
 *   satellite drift. Distance from the last *recorded* point is measured over many
 *   fixes and is naturally robust — drift never accumulates to 50 m.
 *   Slow crawl through traffic (7 km/h) reaches 50 m in ~26 s → recorded cleanly,
 *   no gaps. Under the old speed-averaging approach that same crawl was misclassified
 *   as stopped, causing the 5-minute blackout seen in session 6a61b04d…
 */
class TrackingService : Service() {

    companion object {
        private const val NOTIF_ID   = 4711
        private const val CHANNEL_ID = "jsan_tracking"
        private const val WAKE_TAG   = "jsan:tracking"

        /** Distance the vehicle must travel from the watch position to start a trip. */
        const val TRIP_START_DISTANCE_M     = 30f

        /**
         * Minimum average speed over the first TRIP_START_DISTANCE_M to confirm a
         * vehicle trip (not walking/jogging).
         */
        const val TRIP_START_MIN_SPEED_KMH  = 10.0

        /** Distance from the last recorded point that triggers saving a new point. */
        const val POINT_DISTANCE_M          = 10f

        /**
         * If the vehicle has not moved POINT_DISTANCE_M for this long, the trip ends.
         * 10 min comfortably covers all traffic signal waits (even HITEC City / KPHB
         * junction which runs up to 150 s) without splitting trips.
         */
        const val TRIP_END_NO_MOVE_MS       = 10 * 60 * 1000L

        /**
         * If no trip starts within this window after service launch, stop the service
         * to save battery. ActivityTransitionReceiver re-launches when movement resumes.
         */
        const val IDLE_TIMEOUT_MS           = 10 * 60 * 1000L

        /** GPS-independent ticker interval — drives end-of-trip detection + heartbeat. */
        const val TICK_INTERVAL_MS          = 20_000L

        /** GPS fix request interval. */
        const val LOCATION_INTERVAL_MS      = 3_000L
        const val FASTEST_MS                = 1_000L

        /**
         * While the vehicle is stopped (within the 10 min grace) we re-send the last
         * recorded position at this rate to keep the server session alive and prevent
         * the live-map marker going "stale" (server stale window = 60 s).
         */
        const val STATIONARY_HEARTBEAT_MS   = 30_000L

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TrackingService::class.java))
        }
    }

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var db: LocationDatabase

    /** Keeps CPU alive when screen is off so GPS fixes are not dropped. */
    private var wakeLock: PowerManager.WakeLock? = null

    private val connectivityReceiver = ConnectivityReceiver()

    // ── Trip-start watch state ────────────────────────────────────────────────
    /** First GPS fix after entering idle — reference for measuring the start 50 m. */
    private var startWatchPos: Location? = null
    /** Wall-clock time when startWatchPos was captured (for avg-speed calculation). */
    private var startWatchTime: Long = 0L

    // ── In-trip recording state ───────────────────────────────────────────────
    /** Last recorded position — distance checks use this. */
    private var lastRecordedLat: Double = 0.0
    private var lastRecordedLon: Double = 0.0
    private var hasLastRecorded: Boolean = false
    /** Wall-clock time of the last point written (resets every 50 m). */
    private var lastMovedMs: Long = 0L
    /** Throttles the server keep-alive heartbeat while parked. */
    private var lastHeartbeatMs: Long = 0L

    // ── Misc ─────────────────────────────────────────────────────────────────
    private var lastLocation: Location? = null   // for speed derivation

    /** Reject fixes with accuracy worse than this — underground, urban canyon reflections. */
    private val MAX_ACCURACY_M = 100f

    /**
     * Rolling 3-speed window (same as MyCarTracks' v0(3)) for trip-stop decisions.
     * A single noisy speed reading shouldn't end a trip — require the average of
     * the last 3 readings to be below the moving threshold.
     */
    private val recentSpeeds = ArrayDeque<Double>(4)
    private val SPEED_WINDOW = 3

    private fun addSpeed(speedKmh: Double) {
        recentSpeeds.addLast(speedKmh)
        if (recentSpeeds.size > SPEED_WINDOW) recentSpeeds.removeFirst()
    }

    private fun avgSpeedKmh(): Double {
        if (recentSpeeds.isEmpty()) return 0.0
        return recentSpeeds.sum() / recentSpeeds.size
    }

    /**
     * GPS-independent ticker:
     *   • Detects trip end when GPS goes quiet on a parked vehicle.
     *   • Sends keep-alive heartbeats so the live-map session never goes stale.
     *   • Checks idle timeout so the service self-terminates without a GPS fix.
     */
    private val ticker = Handler(Looper.getMainLooper())
    private val tickRunnable = object : Runnable {
        override fun run() {
            try { onTick() } catch (_: Exception) {}
            // App health heartbeat — sends every ~30s (self-throttled)
            try { HeartbeatSender.sendIfDue(applicationContext) } catch (_: Exception) {}
            ticker.postDelayed(this, TICK_INTERVAL_MS)
        }
    }


    /** Whether we've already auto-detected and persisted the timezone this session. */
    private var timezoneDetected = false

    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { processFix(it) }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        db    = LocationDatabase(this)
        acquireWakeLock()
        registerConnectivityReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat(notification("Waiting for movement…"))

        val now = System.currentTimeMillis()

        // If a trip was active before the service was killed (START_STICKY restart),
        // restore the movement timer so we don't immediately end the trip on restart.
        // hasLastRecorded stays false — processFix will re-anchor on the first fix.
        if (TrackingConfig.currentTripId(this) != null) {
            if (lastMovedMs == 0L) lastMovedMs = now
            if (lastHeartbeatMs == 0L) lastHeartbeatMs = now
        } else {
            // Entering idle — record when we started waiting so idle timeout works.
            if (TrackingConfig.idleSince(this) == 0L) {
                TrackingConfig.setIdleSince(this, now)
            }
        }

        startLocationUpdates()
        registerActivityTransitions()
        ticker.removeCallbacks(tickRunnable)
        ticker.postDelayed(tickRunnable, TICK_INTERVAL_MS)
        triggerUpload()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
        ticker.removeCallbacks(tickRunnable)
        releaseWakeLock()
        try { unregisterReceiver(connectivityReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }

    // ── Wake lock ─────────────────────────────────────────────────────────────

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG)
            wl.setReferenceCounted(false)
            if (!wl.isHeld) wl.acquire()
            wakeLock = wl
        } catch (_: Exception) {}
    }

    private fun releaseWakeLock() {
        try { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null } catch (_: Exception) {}
    }

    // ── Connectivity receiver ─────────────────────────────────────────────────

    private fun registerConnectivityReceiver() {
        try {
            val filter = IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION)
            @Suppress("DEPRECATION")
            registerReceiver(connectivityReceiver, filter)
        } catch (_: Exception) {}
    }

    // ── Core state machine ────────────────────────────────────────────────────

    private fun processFix(location: Location) {
        val now = System.currentTimeMillis()

        // ── Hard reject: awful accuracy ─────────────────────────────────────
        val accuracy = if (location.hasAccuracy()) location.accuracy else 30f
        if (accuracy > MAX_ACCURACY_M) return

        // Use raw GPS coordinates directly — no smoothing, no spike rejection.
        // OSRM map-matching will be added server-side later for road snapping.
        val rawLat = location.latitude
        val rawLon = location.longitude

        // ── Auto-detect timezone from GPS + persist location for sun calc ──
        if (!timezoneDetected) {
            val tzId = SunTimes.detectTimezone(rawLat, rawLon, this)
            TrackingConfig.setTimezoneId(this, tzId)
            timezoneDetected = true
        }
        TrackingConfig.setLastLat(this, rawLat)
        TrackingConfig.setLastLon(this, rawLon)

        // Daylight gating removed: tracking runs at any hour now. It used to end the active trip
        // and pause until sunrise, so a night shift produced no data at all — and the resulting
        // silence let the server watchdog close the trip, after which the device kept sending
        // points into a closed trip and the driver disappeared from Live tracking entirely.

        val speedKmh = computeSpeedKmh(location)   // updates lastLocation
        addSpeed(speedKmh)                             // feed rolling 3-speed window
        val tripId   = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // ── IDLE: watch for a vehicle-speed movement to start a trip ────
            if (startWatchPos == null) {
                startWatchPos  = location
                startWatchTime = now
                return
            }

            val distFromWatch = startWatchPos!!.distanceTo(location)

            if (distFromWatch >= TRIP_START_DISTANCE_M) {
                val elapsedSec    = ((now - startWatchTime) / 1000.0).coerceAtLeast(0.1)
                val avgSpeedKmh   = (distFromWatch / elapsedSec) * 3.6

                if (avgSpeedKmh >= TRIP_START_MIN_SPEED_KMH) {
                    // ── START TRIP ───────────────────────────────────────────
                    val newId = UUID.randomUUID().toString()
                    TrackingConfig.setCurrentTripId(this, newId)
                    TrackingConfig.setIdleSince(this, 0L)

                    lastRecordedLat  = rawLat
                    lastRecordedLon  = rawLon
                    hasLastRecorded  = true
                    lastMovedMs      = now
                    lastHeartbeatMs  = now
                    startWatchPos    = null
                    recentSpeeds.clear()

                    savePoint(rawLat, rawLon, location, speedKmh, newId, "active", now)
                    TrackerEvents.emit("onTripStart", mapOf("tripId" to newId, "recordedAt" to iso(location.time)))
                    TrackerEvents.emit("onLocation",  locMap(rawLat, rawLon, speedKmh, newId, "active", location.time))
                    emitState("tracking")
                    updateNotification("Trip started • ${speedKmh.roundToInt()} km/h")
                    triggerUpload()
                } else {
                    startWatchPos  = location
                    startWatchTime = now
                }
            } else {
                val idleSince = TrackingConfig.idleSince(this)
                if (idleSince > 0L && now - idleSince >= IDLE_TIMEOUT_MS) {
                    emitState("idle_timeout")
                    stopSelf()
                }
            }

        } else {
            // ── TRACKING: record every POINT_DISTANCE_M of real movement ────
            if (!hasLastRecorded) {
                lastRecordedLat = rawLat
                lastRecordedLon = rawLon
                hasLastRecorded = true
                lastMovedMs     = now
                return
            }

            val distFromLast = haversineMeters(
                lastRecordedLat, lastRecordedLon, rawLat, rawLon
            )

            if (distFromLast >= POINT_DISTANCE_M) {
                lastRecordedLat  = rawLat
                lastRecordedLon  = rawLon
                lastMovedMs      = now
                lastHeartbeatMs  = now

                savePoint(rawLat, rawLon, location, speedKmh, tripId, "active", now)
                TrackerEvents.emit("onLocation", locMap(rawLat, rawLon, speedKmh, tripId, "active", location.time))
                updateNotification("Trip • ${speedKmh.roundToInt()} km/h")
                triggerUpload()
            }
        }
    }

    /** Haversine distance in metres between two lat/lon pairs. */
    private fun haversineMeters(
        lat1: Double, lon1: Double, lat2: Double, lon2: Double
    ): Float {
        val R = 6371000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = Math.sin(dLat / 2).let { it * it } +
                Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
                Math.sin(dLon / 2).let { it * it }
        return (2 * R * Math.asin(Math.sqrt(a).coerceAtMost(1.0))).toFloat()
    }

    /**
     * Runs every TICK_INTERVAL_MS regardless of GPS activity.
     *
     *  • Trip end detection: if the vehicle has not moved 10 m in TRIP_END_NO_MOVE_MS,
     *    end the trip. This fires even when the GPS provider stops delivering fixes
     *    on a parked vehicle (fused provider often goes quiet when stationary).
     *
     *  • Server keep-alive: re-send the last position every STATIONARY_HEARTBEAT_MS
     *    while stopped so the live-map session never shows "stale".
     *
     *  • Idle timeout: stop the service if no trip has started within IDLE_TIMEOUT_MS.
     */
    private fun onTick() {
        if (!TrackingConfig.isEnabled(this)) return
        val now    = System.currentTimeMillis()

        // Daylight gating removed: tracking runs at any hour now. It used to end the active trip
        // and pause until sunrise, so a night shift produced no data at all — and the resulting
        // silence let the server watchdog close the trip, after which the device kept sending
        // points into a closed trip and the driver disappeared from Live tracking entirely.

        val tripId = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // Idle — check timeout so the service stops if nobody drives.
            val idleSince = TrackingConfig.idleSince(this)
            if (idleSince > 0L && now - idleSince >= IDLE_TIMEOUT_MS) {
                emitState("idle_timeout")
                stopSelf()
            }
            return
        }

        // Active trip — has the vehicle moved 50 m recently?
        if (lastMovedMs > 0L && now - lastMovedMs >= TRIP_END_NO_MOVE_MS) {
            // 10 minutes without 50 m of movement → vehicle is genuinely parked.
            endTrip(tripId, now)
            return
        }

        // Still within the grace window — keep the server session alive.
        // Only emit a JS event for the live-map; do NOT insert a DB point.
        // Heartbeat points at the same location clutter the route.
        if (now - lastHeartbeatMs >= STATIONARY_HEARTBEAT_MS) {
            lastHeartbeatMs = now
            if (!hasLastRecorded) return
            TrackerEvents.emit("onLocation", mapOf(
                "lat"        to lastRecordedLat,
                "lon"        to lastRecordedLon,
                "speedKmh"   to 0.0,
                "tripId"     to tripId,
                "tripStatus" to "active",
                "recordedAt" to iso(now)
            ))
            val stoppedMin = ((now - lastMovedMs) / 60_000L).toInt()
            updateNotification(if (stoppedMin > 0) "Stopped • $stoppedMin min" else "Stopped")
        }
    }

    // ── Trip end ──────────────────────────────────────────────────────────────

    private fun endTrip(tripId: String, now: Long) {
        val endLat = lastRecordedLat
        val endLon = lastRecordedLon
        insertPoint(endLat, endLon, 0.0, tripId, "ended", now)
        TrackingConfig.setCurrentTripId(this, null)
        TrackingConfig.setIdleSince(this, now)
        hasLastRecorded = false
        lastMovedMs     = 0L
        lastHeartbeatMs = 0L
        startWatchPos   = null
        startWatchTime  = 0L
        recentSpeeds.clear()
        triggerUpload()
        TrackerEvents.emit("onTripEnd", mapOf("tripId" to tripId, "recordedAt" to iso(now)))
        emitState("idle")
        updateNotification("Waiting for movement…")
    }

    // ── Persistence helpers ───────────────────────────────────────────────────

    private fun savePoint(
        lat: Double, lon: Double,
        location: Location, speedKmh: Double,
        tripId: String, status: String, now: Long,
    ) {
        db.insert(QueuedPoint(
            clientId     = UUID.randomUUID().toString(),
            clientTripId = tripId,
            lat          = lat,
            lon          = lon,
            speedKmh     = speedKmh,
            heading      = if (location.hasBearing()) location.bearing.toDouble() else null,
            accuracy     = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
            altitude     = if (location.hasAltitude()) location.altitude else null,
            batteryLevel = batteryLevel(),
            isMoving     = speedKmh > 1.0,
            recordedAt   = iso(if (location.time > 0) location.time else now),
            tripStatus   = status,
        ))
    }

    /** Insert a point without a live Location object (heartbeats, trip-end marker). */
    private fun insertPoint(lat: Double, lon: Double, speedKmh: Double, tripId: String, status: String, now: Long) {
        db.insert(QueuedPoint(
            clientId     = UUID.randomUUID().toString(),
            clientTripId = tripId,
            lat          = lat,
            lon          = lon,
            speedKmh     = speedKmh,
            heading      = null,
            accuracy     = null,
            altitude     = null,
            batteryLevel = batteryLevel(),
            isMoving     = speedKmh > 1.0,
            recordedAt   = iso(now),
            tripStatus   = status,
        ))
    }

    // ── Speed ─────────────────────────────────────────────────────────────────

    /**
     * Prefer GPS-reported Doppler speed (most accurate on modern chipsets).
     * Fall back to distance/time between consecutive fixes if unavailable.
     */
    private fun computeSpeedKmh(location: Location): Double {
        val gps = if (location.hasSpeed() && location.speed >= 0f) location.speed * 3.6 else null
        val derived = lastLocation?.let { last ->
            val dt = (location.time - last.time) / 1000.0
            if (dt > 0) (last.distanceTo(location) / dt) * 3.6 else null
        }
        lastLocation = location
        return gps ?: derived ?: 0.0
    }

    private fun batteryLevel(): Double? {
        val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val lvl = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (lvl in 0..100) lvl / 100.0 else null
    }

    private fun triggerUpload() {
        Thread { Uploader.flush(applicationContext) }.start()
    }

    // ── Location + activity registration ─────────────────────────────────────

    private fun startLocationUpdates() {
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
            .setMinUpdateIntervalMillis(FASTEST_MS)
            .setMinUpdateDistanceMeters(0f)
            .build()
        try {
            fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
        } catch (_: SecurityException) { stopSelf() }
    }

    private fun registerActivityTransitions() {
        try {
            val transitions = buildList {
                // Wake the service when the device enters a vehicle (or other movement).
                listOf(
                    DetectedActivity.IN_VEHICLE,
                    DetectedActivity.ON_BICYCLE,
                    DetectedActivity.ON_FOOT,
                    DetectedActivity.WALKING,
                    DetectedActivity.RUNNING,
                ).forEach { type ->
                    add(ActivityTransition.Builder()
                        .setActivityType(type)
                        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                        .build())
                }
                // STILL transitions — used only to update the pref for ActivityTransitionReceiver;
                // the new distance-based logic no longer uses the STILL flag for trip decisions.
                add(ActivityTransition.Builder()
                    .setActivityType(DetectedActivity.STILL)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                    .build())
                add(ActivityTransition.Builder()
                    .setActivityType(DetectedActivity.STILL)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                    .build())
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            val pi = PendingIntent.getBroadcast(
                this, 100, Intent(this, ActivityTransitionReceiver::class.java), flags
            )
            ActivityRecognition.getClient(this)
                .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pi)
        } catch (_: Exception) {}
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun startForegroundCompat(notif: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else
            startForeground(NOTIF_ID, notif)
    }

    private fun notification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL_ID, "Trip tracking", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
        val launch   = packageManager.getLaunchIntentForPackage(packageName)
        val contentPi = launch?.let {
            PendingIntent.getActivity(
                this, 0, it,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JSAN Auto-Tracking")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(contentPi)
            .build()
    }

    private fun updateNotification(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, notification(text))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun iso(ms: Long): String = isoFmt.format(Date(ms))

    private fun emitState(state: String) =
        TrackerEvents.emit("onStateChange", mapOf("state" to state))

    private fun locMap(
        lat: Double, lon: Double, speedKmh: Double,
        tripId: String, status: String, locationTime: Long,
    ) = mapOf(
        "lat"        to lat,
        "lon"        to lon,
        "speedKmh"   to speedKmh,
        "tripId"     to tripId,
        "tripStatus" to status,
        "recordedAt" to iso(if (locationTime > 0) locationTime else System.currentTimeMillis()),
    )
}
