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
 *   fix → Kalman smooth → distance check → trip state machine → SQLite → upload
 *
 * Trip lifecycle:
 *   IDLE:     watch for 50 m of movement at avg speed ≥ 10 km/h → START trip
 *             (50 m rejects GPS drift; the avg-speed check uses the Kalman-smoothed
 *             position, not the raw fix -- a single noisy fix while someone is simply
 *             walking to their vehicle could otherwise make a short walk look like a
 *             50 m dash at driving speed. NOTE: 10 km/h sits close to jogging pace
 *             (~10 km/h) -- this threshold was lowered from 15 km/h on request; a
 *             sustained jog can legitimately cross it, the smoothing only helps with
 *             GPS-noise false positives, not genuine jogging speed.)
 *
 *   TRACKING: record a point every 50 m moved from the last recorded point.
 *             No speed check needed during a trip — the 50 m rule naturally ignores
 *             GPS noise (drift is < 30 m) and records real movement at any speed.
 *
 *   END:      no 50 m movement for TRIP_END_NO_MOVE_MS (10 min) → end trip.
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
        const val TRIP_START_DISTANCE_M     = 50f

        /**
         * Minimum average speed over the first TRIP_START_DISTANCE_M to confirm a
         * vehicle trip (not walking/jogging).
         * Walking ~5 km/h, jogging ~10 km/h, slowest vehicle ~15 km/h -- lowered to
         * 10 from the original 15 on request. This narrows the margin against
         * jogging specifically (a sustained jog can now cross this bar); the
         * Kalman-smoothing fix below only rejects noise-driven false positives,
         * not genuine sustained jogging speed.
         */
        const val TRIP_START_MIN_SPEED_KMH  = 10.0

        /** Distance from the last recorded point that triggers saving a new point. */
        const val POINT_DISTANCE_M          = 50f

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
        const val LOCATION_INTERVAL_MS      = 10_000L
        const val FASTEST_MS                = 5_000L

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
    /** Smoothed lat/lon of the last point written to SQLite — distance checks
     *  use this so saved coordinates and distance gates are always in sync. */
    private var lastRecordedLat: Double = 0.0
    private var lastRecordedLon: Double = 0.0
    private var hasLastRecorded: Boolean = false
    /** Wall-clock time of the last point written (resets every 50 m). */
    private var lastMovedMs: Long = 0L
    /** Throttles the server keep-alive heartbeat while parked. */
    private var lastHeartbeatMs: Long = 0L

    // ── Misc ─────────────────────────────────────────────────────────────────
    private var lastLocation: Location? = null   // for speed derivation

    /** Max plausible speed between two consecutive fixes — anything above is a GPS spike. */
    private val MAX_PLAUSIBLE_SPEED_KMH = 250.0
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
     * Distance confidence weight based on GPS accuracy (modelled after MyCarTracks w0()).
     * Poor-accuracy fixes get their distance contribution scaled down so they
     * don't inflate the total distance with noise.
     */
    private fun distanceConfidence(accuracyM: Float): Double {
        return when {
            accuracyM <= 10f  -> 1.0
            accuracyM <= 30f  -> 1.0
            accuracyM <= 50f  -> 0.9
            accuracyM <= 100f -> 0.7
            else -> 0.0  // should never reach here (rejected above)
        }
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
            ticker.postDelayed(this, TICK_INTERVAL_MS)
        }
    }

    /**
     * 1-D Kalman smoother (lat + lon independently).
     *
     * Smooths GPS jitter without ever dropping a fix — every satellite reading
     * is blended in, weighted by its reported accuracy (R = accuracy²). A parked
     * device's smoothed position barely moves even when raw fixes jitter ±20 m,
     * so the 50 m distance check naturally ignores that drift.
     */
    private inner class KalmanGPS {
        var lat = 0.0
        var lon = 0.0
        private var varianceM2  = -1.0
        private var lastTimeMs  = 0L
        private val Q_M_PER_SEC = 3.0   // process noise: expected movement m/s

        fun process(rawLat: Double, rawLon: Double, accuracyM: Float, timeMs: Long): Pair<Double, Double> {
            val acc = accuracyM.toDouble().coerceAtLeast(1.0)
            if (varianceM2 < 0 || lastTimeMs == 0L) {
                lat = rawLat; lon = rawLon
                varianceM2 = acc * acc
                lastTimeMs = timeMs
                return Pair(rawLat, rawLon)
            }
            val dtSec = ((timeMs - lastTimeMs) / 1000.0).coerceIn(0.0, 60.0)
            lastTimeMs = timeMs
            varianceM2 += dtSec * Q_M_PER_SEC * Q_M_PER_SEC
            val R = acc * acc
            val K = varianceM2 / (varianceM2 + R)
            lat += K * (rawLat - lat)
            lon += K * (rawLon - lon)
            varianceM2 *= (1.0 - K)
            return Pair(lat, lon)
        }

        fun reset() { varianceM2 = -1.0; lastTimeMs = 0L }
    }

    private val kalman = KalmanGPS()

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
        // Fixes with accuracy > 100 m come from network location, underground,
        // or heavy urban-canyon multipath. They shift the Kalman filter and
        // produce invalid route lines. Reject them entirely.
        val accuracy = if (location.hasAccuracy()) location.accuracy else 30f
        if (accuracy > MAX_ACCURACY_M) return

        // ── Spike rejection: impossible speed between consecutive raw fixes ──
        // A GPS spike (multipath reflection) can report a position km away.
        // If the implied speed from the previous raw fix exceeds 250 km/h,
        // the fix is physically impossible — skip it to protect Kalman and route.
        val prevRaw = lastLocation
        if (prevRaw != null) {
            val dtSec = (location.time - prevRaw.time) / 1000.0
            if (dtSec > 0.1) {
                val impliedKmh = (prevRaw.distanceTo(location) / dtSec) * 3.6
                if (impliedKmh > MAX_PLAUSIBLE_SPEED_KMH) {
                    // Don't update lastLocation — next fix will be checked
                    // against the last known-good fix.
                    return
                }
            }
        }

        // ── Kalman smooth ────────────────────────────────────────────────────
        val (smoothLat, smoothLon) = kalman.process(
            location.latitude, location.longitude, accuracy, location.time
        )

        val speedKmh = computeSpeedKmh(location)   // updates lastLocation
        addSpeed(speedKmh)                             // feed rolling 3-speed window
        val tripId   = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // ── IDLE: watch for a vehicle-speed 50 m run ────────────────────
            // Anchored and measured on the Kalman-smoothed position, not the raw
            // fix -- a single noisy fix (common indoors/near buildings) could
            // otherwise make a short walk look like a fast 50 m dash and start
            // a trip incorrectly. See KalmanGPS above.
            val smoothedFix = Location("smoothed").apply {
                latitude  = smoothLat
                longitude = smoothLon
                time      = location.time
            }

            if (startWatchPos == null) {
                // First fix after idle — anchor the watch position here.
                startWatchPos  = smoothedFix
                startWatchTime = now
                return
            }

            val distFromWatch = startWatchPos!!.distanceTo(smoothedFix)

            if (distFromWatch >= TRIP_START_DISTANCE_M) {
                val elapsedSec    = ((now - startWatchTime) / 1000.0).coerceAtLeast(0.1)
                val avgSpeedKmh   = (distFromWatch / elapsedSec) * 3.6

                if (avgSpeedKmh >= TRIP_START_MIN_SPEED_KMH) {
                    // ── START TRIP ───────────────────────────────────────────
                    val newId = UUID.randomUUID().toString()
                    TrackingConfig.setCurrentTripId(this, newId)
                    TrackingConfig.setIdleSince(this, 0L)

                    // Reset Kalman so it converges to the trip-start position
                    // instead of dragging in stale idle-period drift.
                    kalman.reset()
                    val (startLat, startLon) = kalman.process(
                        location.latitude, location.longitude, accuracy, location.time
                    )

                    lastRecordedLat  = startLat
                    lastRecordedLon  = startLon
                    hasLastRecorded  = true
                    lastMovedMs      = now
                    lastHeartbeatMs  = now
                    startWatchPos    = null
                    recentSpeeds.clear()

                    savePoint(startLat, startLon, location, speedKmh, newId, "active", now)
                    TrackerEvents.emit("onTripStart", mapOf("tripId" to newId, "recordedAt" to iso(location.time)))
                    TrackerEvents.emit("onLocation",  locMap(startLat, startLon, speedKmh, newId, "active", location.time))
                    emitState("tracking")
                    updateNotification("Trip started • ${speedKmh.roundToInt()} km/h")
                    triggerUpload()
                } else {
                    // Speed too low — person is walking. Reset watch to the
                    // current (smoothed) position and try again from here.
                    startWatchPos  = smoothedFix
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
            // ── TRACKING: record every 50 m of real movement ─────────────────
            if (!hasLastRecorded) {
                // START_STICKY restart mid-trip — re-anchor at smoothed position.
                lastRecordedLat = smoothLat
                lastRecordedLon = smoothLon
                hasLastRecorded = true
                lastMovedMs     = now
                return
            }

            // Distance check uses smoothed coords consistently — same coordinate
            // space as what we save, so no raw-vs-smooth mismatch.
            val distFromLast = haversineMeters(
                lastRecordedLat, lastRecordedLon, smoothLat, smoothLon
            )

            if (distFromLast >= POINT_DISTANCE_M) {
                lastRecordedLat  = smoothLat
                lastRecordedLon  = smoothLon
                lastMovedMs      = now
                lastHeartbeatMs  = now

                savePoint(smoothLat, smoothLon, location, speedKmh, tripId, "active", now)
                TrackerEvents.emit("onLocation", locMap(smoothLat, smoothLon, speedKmh, tripId, "active", location.time))
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
     *  • Trip end detection: if the vehicle has not moved 50 m in TRIP_END_NO_MOVE_MS,
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
        // Heartbeat points at the same location clutter the route with
        // micro-segments and inflate distance via Kalman drift.
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
        // Record the final position at speed 0 with status "ended".
        // Use the last recorded smoothed position (not current Kalman which may
        // have drifted during the stationary period).
        val endLat = if (hasLastRecorded) lastRecordedLat else kalman.lat
        val endLon = if (hasLastRecorded) lastRecordedLon else kalman.lon
        insertPoint(endLat, endLon, 0.0, tripId, "ended", now)
        TrackingConfig.setCurrentTripId(this, null)
        TrackingConfig.setIdleSince(this, now)
        hasLastRecorded = false
        lastMovedMs     = 0L
        lastHeartbeatMs = 0L
        startWatchPos   = null
        startWatchTime  = 0L
        recentSpeeds.clear()
        kalman.reset()
        triggerUpload()
        TrackerEvents.emit("onTripEnd", mapOf("tripId" to tripId, "recordedAt" to iso(now)))
        emitState("idle")
        updateNotification("Waiting for movement…")
    }

    // ── Persistence helpers ───────────────────────────────────────────────────

    private fun savePoint(
        smoothLat: Double, smoothLon: Double,
        location: Location, speedKmh: Double,
        tripId: String, status: String, now: Long,
    ) {
        db.insert(QueuedPoint(
            clientId     = UUID.randomUUID().toString(),
            clientTripId = tripId,
            lat          = smoothLat,
            lon          = smoothLon,
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
