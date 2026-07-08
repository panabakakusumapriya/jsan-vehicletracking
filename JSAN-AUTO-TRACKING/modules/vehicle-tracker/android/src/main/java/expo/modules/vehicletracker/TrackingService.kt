package expo.modules.vehicletracker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
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
 * Self-sufficient foreground tracking service. Owns the whole pipeline so it keeps
 * working when the JS/app is killed:
 *   fix (every ~10s) -> trip state machine -> SQLite queue -> upload (when online).
 *
 * Trip lifecycle:
 *   idle    + speed >= 5 km/h            -> START trip (new clientTripId)
 *   moving  + speed ~0 for STOP_GRACE_MS -> END trip ("ended")
 *   idle for >= 20 min (no trip started) -> stop service; Activity-Recognition
 *                                           transitions restart it on next movement.
 */
class TrackingService : Service() {

    companion object {
        private const val NOTIF_ID = 4711
        private const val CHANNEL_ID = "jsan_tracking"

        const val START_SPEED_KMH = 5.0     // auto-start threshold
        const val STOP_SPEED_KMH = 1.0      // treat <= this as "stopped"
        const val STOP_GRACE_MS = 60_000L   // sustained-stop before ending a trip (traffic lights!)
        const val IDLE_TIMEOUT_MS = 20 * 60 * 1000L // 20-min no-movement limit
        const val LOCATION_INTERVAL_MS = 10_000L
        const val FASTEST_MS = 5_000L

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, TrackingService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TrackingService::class.java))
        }
    }

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var db: LocationDatabase
    private var lastLocation: Location? = null

    private val isoFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.locations.forEach { processFix(it) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        db = LocationDatabase(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat(notification("Waiting for movement…"))

        if (TrackingConfig.currentTripId(this) == null && TrackingConfig.idleSince(this) == 0L) {
            TrackingConfig.setIdleSince(this, System.currentTimeMillis())
        }

        startLocationUpdates()
        registerActivityTransitions()
        // Opportunistically flush any backlog left from an offline period.
        triggerUpload()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try {
            fused.removeLocationUpdates(locationCallback)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    // ---- Core state machine ----

    private fun processFix(location: Location) {
        val now = System.currentTimeMillis()
        val speedKmh = computeSpeedKmh(location)
        val tripId = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // IDLE
            if (speedKmh >= START_SPEED_KMH) {
                val newId = UUID.randomUUID().toString()
                TrackingConfig.setCurrentTripId(this, newId)
                TrackingConfig.setStillSince(this, 0L)
                TrackingConfig.setIdleSince(this, 0L)
                persist(location, speedKmh, newId, "active", now)
                TrackerEvents.emit("onTripStart", mapOf("tripId" to newId, "recordedAt" to iso(location.time)))
                TrackerEvents.emit("onLocation", locMap(location, speedKmh, newId, "active"))
                emitState("tracking")
                updateNotification("Trip started • ${speedKmh.roundToInt()} km/h")
                triggerUpload()
            } else {
                val idleSince = TrackingConfig.idleSince(this).let {
                    if (it == 0L) { TrackingConfig.setIdleSince(this, now); now } else it
                }
                if (now - idleSince >= IDLE_TIMEOUT_MS) {
                    // No movement within the 20-min window — back off to save battery.
                    // Activity-Recognition transitions will wake us on the next movement.
                    emitState("idle_timeout")
                    stopSelf()
                }
            }
        } else {
            // TRACKING
            val stopping: Boolean
            if (speedKmh <= STOP_SPEED_KMH) {
                val stillSince = TrackingConfig.stillSince(this).let {
                    if (it == 0L) { TrackingConfig.setStillSince(this, now); now } else it
                }
                stopping = now - stillSince >= STOP_GRACE_MS
            } else {
                if (TrackingConfig.stillSince(this) != 0L) TrackingConfig.setStillSince(this, 0L)
                stopping = false
            }

            if (stopping) {
                persist(location, speedKmh, tripId, "ended", now)
                TrackingConfig.setCurrentTripId(this, null)
                TrackingConfig.setStillSince(this, 0L)
                TrackingConfig.setIdleSince(this, now)
                TrackerEvents.emit("onTripEnd", mapOf("tripId" to tripId, "recordedAt" to iso(location.time)))
                emitState("idle")
                updateNotification("Waiting for movement…")
            } else {
                persist(location, speedKmh, tripId, "active", now)
                TrackerEvents.emit("onLocation", locMap(location, speedKmh, tripId, "active"))
                updateNotification("Trip in progress • ${speedKmh.roundToInt()} km/h")
            }
            triggerUpload()
        }
    }

    private fun persist(location: Location, speedKmh: Double, tripId: String, status: String, now: Long) {
        db.insert(
            QueuedPoint(
                clientId = UUID.randomUUID().toString(),
                clientTripId = tripId,
                lat = location.latitude,
                lon = location.longitude,
                speedKmh = speedKmh,
                heading = if (location.hasBearing()) location.bearing.toDouble() else null,
                accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                altitude = if (location.hasAltitude()) location.altitude else null,
                batteryLevel = batteryLevel(),
                isMoving = speedKmh > STOP_SPEED_KMH,
                recordedAt = iso(if (location.time > 0) location.time else now),
                tripStatus = status
            )
        )
    }

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
            // Location permission was revoked — nothing we can do; shut down.
            stopSelf()
        }
    }

    private fun registerActivityTransitions() {
        try {
            val types = listOf(
                DetectedActivity.IN_VEHICLE,
                DetectedActivity.ON_BICYCLE,
                DetectedActivity.ON_FOOT,
                DetectedActivity.WALKING,
                DetectedActivity.RUNNING
            )
            val transitions = types.map { type: Int ->
                ActivityTransition.Builder()
                    .setActivityType(type)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                    .build()
            }
            val request = ActivityTransitionRequest(transitions)
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            val pi = PendingIntent.getBroadcast(
                this, 100, Intent(this, ActivityTransitionReceiver::class.java), flags
            )
            ActivityRecognition.getClient(this).requestActivityTransitionUpdates(request, pi)
        } catch (_: SecurityException) {
        } catch (_: Exception) {
        }
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
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
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

    // ---- helpers ----

    private fun iso(ms: Long): String = isoFmt.format(Date(ms))

    private fun emitState(state: String) {
        TrackerEvents.emit("onStateChange", mapOf("state" to state))
    }

    private fun locMap(location: Location, speedKmh: Double, tripId: String, status: String) = mapOf(
        "lat" to location.latitude,
        "lon" to location.longitude,
        "speedKmh" to speedKmh,
        "tripId" to tripId,
        "tripStatus" to status,
        "recordedAt" to iso(if (location.time > 0) location.time else System.currentTimeMillis())
    )
}
