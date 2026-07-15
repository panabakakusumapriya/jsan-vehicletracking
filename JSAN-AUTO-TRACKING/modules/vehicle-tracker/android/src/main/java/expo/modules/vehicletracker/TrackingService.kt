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
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.roundToInt

/**
 * Self-sufficient foreground tracking service. Owns the whole pipeline so it keeps
 * working when the JS/app is killed:
 *   fix (every ~10s) -> jump filter -> accuracy filter -> Kalman smooth
 *                    -> STILL override -> speed average -> trip state machine
 *                    -> SQLite queue -> upload (when online).
 *
 * Sensor-fusion anti-drift pipeline (matches MyCarTracks approach):
 *
 *   1. Position-jump filter  — rejects teleport fixes (implied speed > MAX_JUMP_KMH).
 *   2. Accuracy filter       — rejects fixes with horizontal accuracy > MAX_ACCURACY_M.
 *   3. Kalman lat/lon smoother — fuses GPS position + reported accuracy into a smoothed
 *      trace. When the device is still the smoothed position barely moves, so derived speed
 *      naturally collapses toward 0, killing the main source of drift-while-walking.
 *   4. Activity STILL flag   — Google's on-device ML model (accel + gyro) sends
 *      ENTER_STILL via ActivityRecognition. ActivityTransitionReceiver writes it to prefs;
 *      this service reads it and forces effective speed = 0 while STILL is active.
 *      EXIT_STILL clears the flag. This is the same primary signal MyCarTracks uses.
 *   5. Rolling speed average — 3-fix buffer prevents a single noisy fix from changing
 *      trip state.
 *
 * Trip lifecycle:
 *   idle    + effective avg speed >= START_SPEED_KMH  -> START trip
 *   moving  + effective avg speed ~0 for STOP_GRACE_MS -> END trip
 *   idle for IDLE_TIMEOUT_MS (no trip)               -> stop service
 */
class TrackingService : Service() {

    companion object {
        private const val NOTIF_ID          = 4711
        private const val CHANNEL_ID        = "jsan_tracking"
        private const val WAKE_TAG          = "jsan:tracking"

        const val START_SPEED_KMH           = 10.0             // auto-start threshold (raised to avoid GPS noise false starts)
        const val STOP_SPEED_KMH            = 3.0              // treat <= this as "stopped" (raised to absorb GPS noise)
        const val STOP_GRACE_MS             = 20 * 60 * 1000L  // 20 min sustained-stop → end trip
        const val IDLE_TIMEOUT_MS           = 20 * 60 * 1000L  // 20 min no movement → stop service
        const val LOCATION_INTERVAL_MS      = 10_000L
        const val FASTEST_MS                = 5_000L

        /**
         * While stopped (within the 20-min grace) we do NOT record jittering GPS fixes.
         * Instead we re-send the frozen anchor position this often so the server keeps
         * seeing the session as alive (must stay below the backend STALE window of 60s).
         */
        const val STATIONARY_HEARTBEAT_MS   = 30_000L

        /** Reject GPS fixes worse than this accuracy (metres). */
        const val MAX_ACCURACY_M            = 50f

        /** Number of fixes to average for speed decisions. Prevents single-fix false starts. */
        const val SPEED_AVG_WINDOW          = 3

        /**
         * Reject a fix whose implied speed vs. the previous fix exceeds this value.
         * Catches GPS teleport glitches (e.g. first fix after a tunnel, multipath in cities).
         * 250 km/h covers any road vehicle; raise if tracking aircraft.
         */
        const val MAX_JUMP_KMH              = 250.0

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TrackingService::class.java))
        }
    }

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var db: LocationDatabase

    /** PARTIAL_WAKE_LOCK: keeps CPU running when screen is off so GPS fixes are not dropped. */
    private var wakeLock: PowerManager.WakeLock? = null

    /** Rolling speed buffer — prevents single-fix noise from changing trip state. */
    private val speedBuffer = ArrayDeque<Double>(SPEED_AVG_WINDOW)

    private var lastLocation: Location? = null
    private val connectivityReceiver = ConnectivityReceiver()

    /**
     * When stopped, the marker is frozen at this anchor (the spot where we stopped) so parked
     * GPS drift never pollutes the route or the live map. Cleared the moment real movement
     * resumes. `lastHeartbeatMs` throttles the keep-alive point sent while parked.
     */
    private var stopAnchorLat: Double? = null
    private var stopAnchorLon: Double? = null
    private var lastHeartbeatMs: Long = 0L

    /**
     * 1-D Kalman smoother applied independently to latitude and longitude.
     *
     * State  : position (degrees, but the maths treats them as metres-equivalent).
     * Process noise Q : expected position uncertainty growth per second due to movement.
     *   3 m/s  → a slow-walking device; keeps the filter from lagging too far behind a
     *            moving vehicle while still aggressively smoothing stationary drift.
     * Measurement noise R : GPS horizontal accuracy² (reported per fix by the OS).
     *
     * When the device is STILL the smoothed position barely changes between fixes, so
     * distance/time derived speed collapses toward 0 — that is the primary drift cure.
     */
    private inner class KalmanGPS {
        var lat = 0.0
        var lon = 0.0
        private var varianceM2   = -1.0   // negative = not yet initialised
        private var lastTimeMs   = 0L
        private val Q_M_PER_SEC  = 3.0   // process noise (m/s)

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

            // Predict: variance grows with time (device might have moved)
            varianceM2 += dtSec * Q_M_PER_SEC * Q_M_PER_SEC

            // Update: blend new measurement using Kalman gain
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

    // ---- Lifecycle ----

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        db    = LocationDatabase(this)
        acquireWakeLock()
        registerConnectivityReceiver()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat(notification("Waiting for movement…"))

        if (TrackingConfig.currentTripId(this) == null && TrackingConfig.idleSince(this) == 0L) {
            TrackingConfig.setIdleSince(this, System.currentTimeMillis())
        }

        // Clear speed buffer on each service start so a kill+restart doesn't inherit
        // a partial (zero-padded) window that could cause false stop decisions.
        speedBuffer.clear()

        startLocationUpdates()
        registerActivityTransitions()
        // Opportunistically flush any backlog left from an offline period.
        triggerUpload()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
        releaseWakeLock()
        try { unregisterReceiver(connectivityReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }

    // ---- Wake lock (MyCarTracks: AbstractAutoTrackingService.onCreate bytecode) ----

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG)
            wl.setReferenceCounted(false)
            if (!wl.isHeld) wl.acquire()
            wakeLock = wl
        } catch (e: Exception) {
            // Non-fatal — tracking continues, just with less CPU guarantee.
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
        } catch (_: Exception) {}
    }

    // ---- Connectivity receiver ----

    private fun registerConnectivityReceiver() {
        try {
            val filter = IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION)
            @Suppress("DEPRECATION")
            registerReceiver(connectivityReceiver, filter)
        } catch (_: Exception) {}
    }

    // ---- Core state machine ----

    private fun processFix(location: Location) {
        // ── 1. Position-jump filter: reject teleport fixes ──────────────────────────
        // Compute implied speed vs last accepted fix. If physically impossible, skip
        // this fix but still advance lastLocation so the next fix has a fresh baseline.
        val last = lastLocation
        if (last != null) {
            val dtMs = location.time - last.time
            if (dtMs > 0) {
                val impliedKmh = (last.distanceTo(location) / (dtMs / 1000.0)) * 3.6
                if (impliedKmh > MAX_JUMP_KMH) {
                    lastLocation = location   // reset baseline to avoid cascading rejects
                    kalman.reset()
                    return
                }
            }
        }

        // ── 2. Accuracy filter ───────────────────────────────────────────────────────
        if (location.hasAccuracy() && location.accuracy > MAX_ACCURACY_M) return

        // ── 3. Kalman smooth ─────────────────────────────────────────────────────────
        val accuracy = if (location.hasAccuracy()) location.accuracy else 30f
        val (smoothLat, smoothLon) = kalman.process(
            location.latitude, location.longitude, accuracy, location.time
        )

        // ── 4. Speed ─────────────────────────────────────────────────────────────────
        val rawSpeedKmh = computeSpeedKmh(location)   // also updates lastLocation

        // ── 5. Activity Recognition (accelerometer + gyro, on-device ML) ─────────────
        // STILL is the trustworthy "we're parked" signal — Google's fused sensor model can't
        // be fooled by GPS drift. We keep the speed buffer on REAL GPS speed and fuse STILL
        // into the stop decision below, so a *stale* STILL flag (the ML lags a few seconds
        // leaving a stop) can still be vetoed by clearly genuine GPS movement (>= START).
        val activityStill = TrackingConfig.isStill(this)
        val speedKmh      = rawSpeedKmh
        val avgSpeed      = averageSpeed(speedKmh)

        val now    = System.currentTimeMillis()
        val tripId = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // IDLE — only start a trip when we have genuine averaged movement AND the
            // activity recogniser agrees we are not still.
            if (avgSpeed >= START_SPEED_KMH && !activityStill) {
                val newId = UUID.randomUUID().toString()
                TrackingConfig.setCurrentTripId(this, newId)
                TrackingConfig.setStillSince(this, 0L)
                TrackingConfig.setIdleSince(this, 0L)
                persistSmoothed(smoothLat, smoothLon, location, speedKmh, newId, "active", now)
                TrackerEvents.emit("onTripStart", mapOf("tripId" to newId, "recordedAt" to iso(location.time)))
                TrackerEvents.emit("onLocation", locMapSmoothed(smoothLat, smoothLon, location, speedKmh, newId, "active"))
                emitState("tracking")
                updateNotification("Trip started • ${speedKmh.roundToInt()} km/h")
                triggerUpload()
            } else {
                val idleSince = TrackingConfig.idleSince(this).let {
                    if (it == 0L) { TrackingConfig.setIdleSince(this, now); now } else it
                }
                if (now - idleSince >= IDLE_TIMEOUT_MS) {
                    emitState("idle_timeout")
                    stopSelf()
                }
            }
        } else {
            // TRACKING
            // "Stopped" fuses two signals: a Kalman-smoothed speed at/below the stop threshold
            // (catches a real stop immediately), OR the activity recogniser's STILL verdict
            // (Google's on-device accelerometer+gyro ML model — immune to GPS drift) as long as
            // GPS isn't clearly showing genuine driving. That veto (`avgSpeed < START`) keeps a
            // lagging STILL flag from freezing the marker when the vehicle is actually moving.
            // While stopped we FREEZE the marker at an anchor and stop recording jittering
            // fixes — that is what kills the parked GPS noise.
            val stopped = avgSpeed <= STOP_SPEED_KMH || (activityStill && avgSpeed < START_SPEED_KMH)

            if (stopped) {
                // Mark the moment we became stationary and anchor the position there.
                if (TrackingConfig.stillSince(this) == 0L) {
                    TrackingConfig.setStillSince(this, now)
                    lastHeartbeatMs = 0L // force an immediate keep-alive at the new anchor
                }
                if (stopAnchorLat == null) { stopAnchorLat = smoothLat; stopAnchorLon = smoothLon }
                val aLat = stopAnchorLat!!
                val aLon = stopAnchorLon!!
                val stillSince = TrackingConfig.stillSince(this)

                if (now - stillSince >= STOP_GRACE_MS) {
                    // Sustained 20-min stop → end the trip cleanly at the anchor.
                    persistSmoothed(aLat, aLon, location, 0.0, tripId, "ended", now)
                    TrackingConfig.setCurrentTripId(this, null)
                    TrackingConfig.setStillSince(this, 0L)
                    TrackingConfig.setIdleSince(this, now)
                    stopAnchorLat = null; stopAnchorLon = null
                    lastHeartbeatMs = 0L
                    speedBuffer.clear()
                    kalman.reset()
                    TrackerEvents.emit("onTripEnd", mapOf("tripId" to tripId, "recordedAt" to iso(location.time)))
                    emitState("idle")
                    updateNotification("Waiting for movement…")
                } else {
                    // Parked within grace: drop the noisy fix, keep the marker frozen at the
                    // anchor, and send a low-rate keep-alive so the session never shows "stale".
                    if (now - lastHeartbeatMs >= STATIONARY_HEARTBEAT_MS) {
                        lastHeartbeatMs = now
                        persistSmoothed(aLat, aLon, location, 0.0, tripId, "active", now)
                        TrackerEvents.emit("onLocation", locMapSmoothed(aLat, aLon, location, 0.0, tripId, "active"))
                    }
                    updateNotification("Parked • stopped ${((now - stillSince) / 60000L).toInt()} min")
                }
            } else {
                // Genuine movement → record the real smoothed position. Only speed >= START
                // clears the stop timer; the STOP..START band is treated as residual noise and
                // does not reset the grace countdown, so a trip can still close.
                if (avgSpeed >= START_SPEED_KMH && TrackingConfig.stillSince(this) != 0L) {
                    TrackingConfig.setStillSince(this, 0L)
                }
                stopAnchorLat = null; stopAnchorLon = null
                lastHeartbeatMs = now
                persistSmoothed(smoothLat, smoothLon, location, speedKmh, tripId, "active", now)
                TrackerEvents.emit("onLocation", locMapSmoothed(smoothLat, smoothLon, location, speedKmh, tripId, "active"))
                updateNotification("Trip in progress • ${speedKmh.roundToInt()} km/h")
            }
            triggerUpload()
        }
    }

    /**
     * Maintains a rolling SPEED_AVG_WINDOW-fix speed buffer and returns the average.
     * Same as MyCarTracks v0(3) buffer — prevents single-fix GPS noise from
     * triggering false trip starts or premature stops.
     */
    private fun averageSpeed(current: Double): Double {
        if (speedBuffer.size >= SPEED_AVG_WINDOW) speedBuffer.poll()
        speedBuffer.add(current)
        return speedBuffer.average()
    }

    /** Persist using Kalman-smoothed lat/lon; raw location supplies metadata (heading, altitude, etc.). */
    private fun persistSmoothed(
        smoothLat: Double, smoothLon: Double,
        location: Location, speedKmh: Double,
        tripId: String, status: String, now: Long,
    ) {
        db.insert(
            QueuedPoint(
                clientId      = UUID.randomUUID().toString(),
                clientTripId  = tripId,
                lat           = smoothLat,
                lon           = smoothLon,
                speedKmh      = speedKmh,
                heading       = if (location.hasBearing()) location.bearing.toDouble() else null,
                accuracy      = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                altitude      = if (location.hasAltitude()) location.altitude else null,
                batteryLevel  = batteryLevel(),
                isMoving      = speedKmh > STOP_SPEED_KMH,
                recordedAt    = iso(if (location.time > 0) location.time else now),
                tripStatus    = status
            )
        )
    }

    /**
     * Hybrid speed: prefer GPS-reported speed (most accurate); fall back to
     * distance/time between consecutive fixes.
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

    // ---- Location + activity registration ----

    private fun startLocationUpdates() {
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
            .setMinUpdateIntervalMillis(FASTEST_MS)
            .setMinUpdateDistanceMeters(0f)
            .build()
        try {
            fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
        } catch (_: SecurityException) {
            stopSelf()
        }
    }

    private fun registerActivityTransitions() {
        try {
            val movingTypes = listOf(
                DetectedActivity.IN_VEHICLE,
                DetectedActivity.ON_BICYCLE,
                DetectedActivity.ON_FOOT,
                DetectedActivity.WALKING,
                DetectedActivity.RUNNING,
            )
            val transitions = buildList {
                // ENTER movement → wake service (existing behaviour)
                movingTypes.forEach { type ->
                    add(ActivityTransition.Builder()
                        .setActivityType(type)
                        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                        .build())
                }
                // ENTER / EXIT STILL → update the isStill pref so processFix can zero GPS drift
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

    // ---- Notification / foreground ----

    private fun startForegroundCompat(notif: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun notification(text: String): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Trip tracking", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
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

    // ---- Helpers ----

    private fun iso(ms: Long): String = isoFmt.format(Date(ms))

    private fun emitState(state: String) {
        TrackerEvents.emit("onStateChange", mapOf("state" to state))
    }

    private fun locMapSmoothed(
        smoothLat: Double, smoothLon: Double,
        location: Location, speedKmh: Double,
        tripId: String, status: String,
    ) = mapOf(
        "lat"        to smoothLat,
        "lon"        to smoothLon,
        "speedKmh"   to speedKmh,
        "tripId"     to tripId,
        "tripStatus" to status,
        "recordedAt" to iso(if (location.time > 0) location.time else System.currentTimeMillis())
    )
}
