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
import android.os.SystemClock
import android.util.Log
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
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
 *   IDLE:     watch for movement to start a trip, by either gate:
 *               fast — 30 m (or 1.5× the fix accuracy) at avg ≥ 10 km/h, the normal pull-away;
 *               slow — 100 m at avg ≥ 2 km/h with the activity model's last verdict "in a
 *                      vehicle": congestion never reaches 10 km/h, and before this gate those
 *                      trips only began once traffic freed up, losing everything before that.
 *             (The distance floor rejects GPS drift; the speed/activity checks prevent
 *             walking from starting a trip.)
 *
 *   TRACKING: record a point every 10 m moved from the last recorded point, with a time
 *             trigger for slow traffic. Movement has three witnesses (activity model, GPS
 *             speed, raw displacement past the error radius) — any one is enough, because in
 *             dense traffic the first two both read a crawl as "parked".
 *
 *   END:      no recorded movement for TRIP_END_NO_MOVE_MS (10 min) → end trip.
 *             Checked by the GPS-independent ticker so it fires even when GPS goes
 *             quiet on a parked vehicle. A stop shorter than that grace — however complete —
 *             keeps the trip: pulling away again simply resumes recording.
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
        private const val EXTRA_ACTIVITY_WAKE = "activityWake"


        /** Distance the vehicle must travel from the watch position to start a trip. */
        const val TRIP_START_DISTANCE_M     = 30f

        /**
         * Minimum average speed over the first TRIP_START_DISTANCE_M to confirm a
         * vehicle trip (not walking/jogging).
         */
        const val TRIP_START_MIN_SPEED_KMH  = 10.0

        /**
         * The congestion path into a trip. A queue crawling out of a gate never reaches
         * 10 km/h over any 30 m stretch, so a watch that has accumulated this much ground at
         * at least TRIP_START_SLOW_MIN_SPEED_KMH also starts a trip — but only while the
         * activity model's last word was "in a vehicle", because 100 m at 3 km/h is also just
         * a pedestrian. With no verdict stored (no Play Services), the slow gate stays closed
         * and behaviour is exactly the old fast-gate-only one.
         */
        const val TRIP_START_SLOW_DISTANCE_M    = 100f
        const val TRIP_START_SLOW_MIN_SPEED_KMH = 2.0

        /**
         * The slow gate is VETOED by a fresh on-foot verdict rather than REQUIRING a fresh
         * vehicle one. Requiring the positive verdict was the wrong default for this fleet:
         * Activity Recognition classifies a survey crawl poorly (slow driving often never earns
         * IN_VEHICLE at all), the verdict lingers on "foot" after the driver walks around the
         * car, and there is none right after boot — each of those held the gate shut and lost
         * billable slow driving (measured: 33 km recorded against a reference app's 43 for one
         * session). Walking still cannot start a trip while its verdict is this fresh, and a
         * walk long enough to outlive the veto keeps re-firing WALKING transitions anyway.
         */
        const val FOOT_VETO_MS = 10 * 60 * 1000L

        /**
         * The VEHICLE gate — the one that does not ask how fast you are going.
         *
         * Both gates above are speed-shaped, and speed is a bad proxy for "this is a vehicle" on
         * this fleet's roads: a survey crawl, a queue at a gate or a jam never averages
         * TRIP_START_MIN_SPEED_KMH, and below TRIP_START_SLOW_MIN_SPEED_KMH nothing could start a
         * trip at all. So when MotionClassifier has positively identified a VEHICLE from the
         * sensors (gait absence, cadence, gyro, activity model, speed — see that file), the trip
         * starts on movement alone: this much ground covered at barely more than walking pace.
         *
         * The distance floor is smaller than the fast gate's because the classifier has already
         * ruled out the thing the distance was guarding against — a pedestrian. What remains to
         * guard against is GPS drift, so the accuracy bar is TIGHTER than either other gate
         * (drift scales with the error radius, and 20 m is inside a 50 m error radius), and the
         * jitter floor scales at 2x rather than 1.5x.
         *
         * At 1 km/h this fires after ~72 s of creeping — and PRE_START_BUFFER then backfills the
         * route from the first metre, so the trip still begins where the movement did.
         */
        const val TRIP_START_VEHICLE_DISTANCE_M     = 20f
        const val TRIP_START_VEHICLE_MIN_SPEED_KMH  = 0.8
        const val TRIP_START_VEHICLE_MAX_ACCURACY_M = 25f

        /**
         * How often Play Services reports the ranked activity list WITH confidences. The
         * transition API this service already uses only fires on edges and carries no
         * confidence, which is why a stale ON_FOOT from walking to the car could veto the slow
         * gate for ten minutes; these updates let MotionClassifier weigh both how sure the model
         * is and how long ago it said so.
         */
        const val ACTIVITY_UPDATE_INTERVAL_MS = 10_000L

        /**
         * Baseline bounds for the ground speed handed to MotionClassifier. Doppler speed from a
         * single fix collapses to zero at a crawl — the exact regime the vehicle gate exists to
         * catch — so the classifier is also fed displacement measured over a sliding 8-30 s
         * window, which stays honest down to walking pace. Shorter than the minimum and jitter
         * dominates; longer than the maximum and a vehicle pulling away after a long park reads
         * as stationary because the reference is stale.
         */
        const val GROUND_REF_MIN_MS = 8_000L
        const val GROUND_REF_MAX_MS = 30_000L

        /**
         * The pre-start buffer. Everything driven BEFORE the start gate passes used to be lost:
         * the gate decides that a trip exists, but it also decided where the trip began, and a
         * slow departure could creep for minutes (and hundreds of metres) before it fired. While
         * idle, good fixes are remembered here and flushed into the trip retroactively the
         * moment it starts — the trip then begins where the movement began, whichever gate
         * eventually recognised it. Spacing keeps a parked phone from filling it with jitter;
         * the age window bounds it to the approach that actually led to this trip.
         */
        const val PRE_START_BUFFER_MS        = 5 * 60 * 1000L
        const val PRE_START_BUFFER_MAX       = 240
        const val PRE_START_BUFFER_SPACING_M = 5f

        /** Distance from the last recorded point that triggers saving a new point. */
        const val POINT_DISTANCE_M          = 10f

        /**
         * Route points use an ADAPTIVE precision rule: movement only counts once it exceeds
         * the fix's own error radius (see the record gate). A flat 35 m cutoff was tried
         * first and starved real tracking — a phone in a pocket or bag rides at 35–80 m
         * accuracy for whole shifts, which recorded nothing and let the 10-minute no-move
         * timer end live trips mid-drive. TRIP STARTS stay stricter: arming a new trip off a
         * fuzzy fix is how a parked phone "starts driving" (Ali Azhar, 2026-09-07: 48 m avg
         * accuracy, 9.7 phantom km inside a 3 km box).
         */
        const val TRIP_START_MAX_ACCURACY_M = 50f

        /** A recorded-point jump implying more than this is a GPS teleport, not driving —
         *  Ali's same session carried a 211 km/h spike from one multipath bounce. */
        const val MAX_PLAUSIBLE_SPEED_KMH   = 180.0

        /**
         * Density controls for slow / congested driving. Recording is decided by MOVEMENT, not
         * by accuracy — a stop-go city drive (madhav, 2026-09-07: 33 min, avg 14 km/h) produced
         * only 19 points at 106 m spacing because the old gate spaced points by GPS error and
         * suppressed every sub-8 km/h crawl. Map-matching then failed (0.45 of 3 km snapped).
         */
        // Record at least this often while the vehicle is moving, even under the distance gate —
        // this is what keeps a 5 km/h jam crawl dense enough for the matcher.
        const val RECORD_MIN_INTERVAL_MS    = 8_000L
        // The time trigger still needs SOME real displacement, so a dead-stop does not mint a
        // point every 8 s of pure GPS jitter. 3 m in 8 s is ~1.4 km/h — slower than that is a
        // stop, not a crawl. The record gate scales this floor up with the fix's own error
        // radius, so a noisy parked fix cannot fake 3 m.
        const val RECORD_MIN_MOVE_M         = 3f
        // Above this GPS speed the vehicle is moving even if the activity model still says STILL
        // (a slow crawl reads as still to the detector) — so crawling traffic is never suppressed.
        const val RECORD_MOVING_SPEED_KMH   = 3.0

        /**
         * If the vehicle has not moved POINT_DISTANCE_M for this long, the trip ends.
         * 10 min comfortably covers all traffic signal waits (even HITEC City / KPHB
         * junction which runs up to 150 s) without splitting trips.
         */
        const val TRIP_END_NO_MOVE_MS       = 10 * 60 * 1000L

        /**
         * Hard cap on one trip's length. Anything past this is a forgotten session, not a
         * drive — end it so the server can snap it, and let the next movement start a fresh
         * trip. Mirrored server-side (TRIP_MAX_DURATION_HOURS) as a backstop for old builds.
         */
        const val TRIP_MAX_DURATION_MS      = 8 * 60 * 60 * 1000L

        /**
         * If no trip starts within this window after service launch, stop the service
         * to save battery. ActivityTransitionReceiver re-launches when movement resumes.
         */
        const val IDLE_TIMEOUT_MS           = 10 * 60 * 1000L

        /** GPS-independent ticker interval — drives end-of-trip detection + heartbeat. */
        const val TICK_INTERVAL_MS          = 20_000L

        /**
         * GPS fix interval while the vehicle is actually moving.
         *
         * Kept at 2 s: the route drawn on the map is only as good as its densest sampling, and at
         * 60 km/h a 2 s gap is already 33 m of straight-lined corner.
         */
        const val LOCATION_INTERVAL_MS      = 2_000L
        const val FASTEST_MS                = 1_000L

        /**
         * GPS fix interval while stopped. A parked vehicle produces no route detail, so sampling
         * it five times a minute instead of twenty is free accuracy-wise and is most of the
         * battery saving — GPS is the single hungriest thing this service does.
         *
         * The cost is latency noticing that movement resumed: up to 10 s, which at 60 km/h is
         * ~170 m of route missed at the start of a pull-away. Accepted because trip START is
         * guarded separately by TRIP_START_DISTANCE_M, and ActivityTransitionReceiver fires an
         * IN_VEHICLE transition that snaps us back to the moving cadence before this interval
         * would.
         */
        const val LOCATION_INTERVAL_STATIONARY_MS = 10_000L
        /** Low-power watch after the initial idle window; enough to feed motion fusion. */
        const val LOCATION_INTERVAL_DORMANT_MS = 30_000L

        /**
         * How long without movement before dropping to the stationary cadence. Longer than a
         * typical traffic light so a normal junction wait does not thrash GPS between rates.
         */
        const val STATIONARY_AFTER_MS       = 60_000L

        /**
         * Upload cadence — batching window, NOT the GPS rate.
         *
         * These exist because uploading was previously triggered on every recorded point: one HTTP
         * request per fix, ~313 bytes of GPS inside an ~850 byte envelope, every 3 seconds. Two
         * costs, and the second is the one drivers actually felt:
         *   - 73% of mobile data was HTTP/TLS envelope rather than position data.
         *   - The cellular radio stays in a high-power state ~10-20 s after each transmission, so
         *     a request every 3 s pinned it at full power for an entire shift. That is the
         *     overheating, far more than GPS.
         *
         * Batching to 10 s while moving lets the radio idle between bursts and cuts the envelope
         * cost roughly threefold. 10 s also matches what the backend expects for a live session
         * (server stale window is 60 s), so the live map does not suffer.
         */
        const val UPLOAD_INTERVAL_MOVING_MS     = 10_000L
        const val UPLOAD_INTERVAL_STATIONARY_MS = 30_000L

        /**
         * While the vehicle is stopped (within the 10 min grace) we re-send the last
         * recorded position at this rate to keep the server session alive and prevent
         * the live-map marker going "stale" (server stale window = 60 s).
         */
        const val STATIONARY_HEARTBEAT_MS   = 30_000L

        /**
         * How often an IDLE fix is emitted to JS while no trip is running. The driver's map dot
         * rides these events; before them it sat on the previous trip's endpoint until the
         * trip-start gate (TRIP_START_DISTANCE_M at TRIP_START_MIN_SPEED_KMH) passed, the batch
         * uploaded and the poll returned — the reported "stale dot". JS-event only: nothing is
         * recorded or uploaded for an idle fix.
         */
        const val IDLE_EMIT_MS              = 5_000L

        /**
         * Ask for the service, and never throw at the caller.
         *
         * Three of the four callers are BroadcastReceivers, where an escaping exception is an app
         * crash rather than a failed start — and Android 12+ throws
         * ForegroundServiceStartNotAllowedException here whenever the app is in the background
         * and not exempt from battery optimisation. That is precisely the state a phone is in
         * when Activity Recognition reports the driver has started moving, so the one path that
         * exists to resume tracking was also the one most likely to kill the app instead.
         *
         * A refused start hands off to the watchdog alarm, which will try again from a context
         * the system is happier about.
         */
        fun start(ctx: Context, activityWake: Boolean = false) {
            val intent = Intent(ctx, TrackingService::class.java)
                .putExtra(EXTRA_ACTIVITY_WAKE, activityWake)
            try {
                ContextCompat.startForegroundService(ctx, intent)
            } catch (e: Exception) {
                Log.w("JSANTracking", "startForegroundService refused: ${e.message}")
                ServiceWatchdog.scheduleRetry(ctx)
            }
        }

        /**
         * How long the fused provider may go silent before we stop believing in it.
         *
         * Google Play Services is not present on every handset this fleet buys (and is stale or
         * disabled on plenty more). requestLocationUpdates does not throw in that case — it
         * returns a Task that quietly never delivers, so the service looked perfectly healthy
         * while recording nothing at all. This is the timeout that turns that silence into a
         * switch to the platform LocationManager.
         */
        const val NO_FIX_FALLBACK_MS = 90_000L

        /** App-health heartbeat cadence, by how much is actually going on. */
        const val HEARTBEAT_ACTIVE_MS  = 30_000L
        const val HEARTBEAT_IDLE_MS    = 2 * 60 * 1000L
        const val HEARTBEAT_DORMANT_MS = 10 * 60 * 1000L

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TrackingService::class.java))
        }
    }

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var db: LocationDatabase

    /** Vehicle-vs-foot sensor fusion. Owns the accelerometer/gyroscope while the service runs. */
    private lateinit var motion: MotionClassifier
    private var activityUpdatesPi: PendingIntent? = null
    /** configure/start may be called by session bootstrap, Home, and AppState; initialise once. */
    private var runtimeStarted = false
    /** Sparse, balanced-power monitoring after IDLE_TIMEOUT_MS; classifier remains alive. */
    private var dormant = false

    /** Set once we have given up on Play Services and driven GPS ourselves instead. */
    private var legacyProviderActive = false
    /** elapsedRealtime of the last fix from ANY provider — drives NO_FIX_FALLBACK_MS. */
    private var lastFixElapsedMs = 0L
    /** Last text pushed to the notification, so identical updates are not re-posted. */
    private var lastNotificationText: String? = null
    /** Created once; recreating it on every notification update is pure overhead. */
    private var notificationChannelReady = false

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
    /** Wall-clock time of the last point written (refreshed on every recorded point). */
    private var lastMovedMs: Long = 0L
    /** Throttles the server keep-alive heartbeat while parked. */
    private var lastHeartbeatMs: Long = 0L
    private var tripStartedElapsedMs: Long = 0L
    private var idleStartedElapsedMs: Long = 0L

    // ── Misc ─────────────────────────────────────────────────────────────────
    private var lastLocation: Location? = null   // for speed derivation
    private var lastIdleEmitMs = 0L              // throttles idle fixes emitted to JS
    private var lastRecordedAtMs = 0L            // when the last route point was minted (teleport gate)

    // ── Long-baseline ground speed for MotionClassifier (see GROUND_REF_MIN_MS) ──
    private var groundRefLoc: Location? = null
    private var groundRefMs: Long = 0L
    private var lastGroundKmh: Double? = null
    private var lastGroundAtMs: Long = 0L

    /** One remembered idle fix — see PRE_START_BUFFER_MS. */
    private data class BufferedFix(
        val lat: Double, val lon: Double, val speedKmh: Double,
        val heading: Double?, val accuracy: Double?, val altitude: Double?,
        val timeMs: Long,
        val elapsedMs: Long,
    )
    private val preStartBuffer = ArrayDeque<BufferedFix>()

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
            // App health heartbeat. Rate depends on whether anything is actually happening:
            // a parked or dormant phone was sending 2,880 of these a day, each one waking the
            // cellular radio into its high-power state for 10-20 s. That is the same cost the
            // upload batching was introduced to remove, being paid all night for a payload that
            // has not changed.
            try {
                HeartbeatSender.sendIfDue(applicationContext, heartbeatIntervalMs())
            } catch (_: Exception) {}
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

    /** Fixes from the platform provider when Play Services cannot supply them. */
    private val legacyListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = processFix(location)
        @Deprecated("Required below API 29; no longer called above it.")
        override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        fused  = LocationServices.getFusedLocationProviderClient(this)
        db     = LocationDatabase(this)
        motion = MotionClassifier(applicationContext)
        motion.start()
        registerConnectivityReceiver()
        ServiceWatchdog.schedule(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (runtimeStarted) {
            if (intent?.getBooleanExtra(EXTRA_ACTIVITY_WAKE, false) == true && dormant) {
                dormant = false
                motion.setLowPower(false)
                TrackingConfig.setIdleSince(this, System.currentTimeMillis())
                idleStartedElapsedMs = SystemClock.elapsedRealtime()
                applyCadence(idleStartedElapsedMs)
                updateNotification("Vehicle movement detected")
            }
            return START_STICKY
        }
        runtimeStarted = true
        startForegroundCompat(notification("Waiting for movement…"))

        val now = SystemClock.elapsedRealtime()
        val wallNow = System.currentTimeMillis()

        // If a trip was active before the service was killed (START_STICKY restart),
        // restore the movement timer so we don't immediately end the trip on restart.
        // hasLastRecorded stays false — processFix will re-anchor on the first fix.
        if (TrackingConfig.currentTripId(this) != null) {
            acquireWakeLock()
            tripStartedElapsedMs = now
            if (lastMovedMs == 0L) lastMovedMs = now
            if (lastHeartbeatMs == 0L) lastHeartbeatMs = now
        } else {
            releaseWakeLock()
            // Entering idle — record when we started waiting so idle timeout works.
            if (TrackingConfig.idleSince(this) == 0L) {
                TrackingConfig.setIdleSince(this, wallNow)
            }
            idleStartedElapsedMs = now
        }

        registerActivityTransitions()
        registerActivityUpdates()
        ticker.removeCallbacks(tickRunnable)
        ticker.postDelayed(tickRunnable, TICK_INTERVAL_MS)

        // applyCadence registers the LocationRequest itself, at whichever rate the current state
        // calls for — so there is no separate startLocationUpdates() call here. `cadence = null`
        // guarantees it cannot take its no-change early return and leave GPS unregistered.
        cadence = null
        // The silence timer runs from now, not from the first fix: a provider that never delivers
        // anything at all would otherwise never trip it, and that is exactly the failure mode on
        // a handset without usable Google Play Services.
        lastFixElapsedMs = now
        applyCadence(now)
        uploadTicker.removeCallbacks(uploadRunnable)
        uploadTicker.postDelayed(uploadRunnable, uploadIntervalMs())

        // One immediate drain on start: anything buffered while the service was dead should not
        // wait out a full window.
        triggerUpload()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * The driver swiping the app out of Recents must not end their shift.
     *
     * Stock Android keeps a started foreground service running here, but MIUI, ColorOS,
     * FuntouchOS and EMUI all tear the process down on a swipe and ignore START_STICKY while
     * doing it. The alarm outlives the process, so it is the only thing that can still put the
     * service back afterwards.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        if (TrackingConfig.isEnabled(this)) ServiceWatchdog.scheduleRetry(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
        stopLegacyLocationUpdates()
        // Whatever is taking the service down — OEM killer, memory pressure, stopSelf — leave the
        // alarm armed unless tracking was deliberately switched off, so there is a way back.
        if (TrackingConfig.isEnabled(this)) ServiceWatchdog.scheduleRetry(this, 30_000L)
        else ServiceWatchdog.cancel(this)
        motion.stop()
        // Transitions are deliberately LEFT registered — they are what wakes this service back up
        // after the idle timeout. Continuous updates only feed the classifier, which is not
        // running once the service is gone, so they are released here.
        activityUpdatesPi?.let { pi ->
            try { ActivityRecognition.getClient(this).removeActivityUpdates(pi) } catch (_: Exception) {}
        }
        activityUpdatesPi = null
        ticker.removeCallbacks(tickRunnable)
        uploadTicker.removeCallbacks(uploadRunnable)
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
        val now = SystemClock.elapsedRealtime()
        val wallNow = System.currentTimeMillis()
        // Proof of life for whichever provider delivered this — see NO_FIX_FALLBACK_MS.
        lastFixElapsedMs = now

        // ── Hard reject: awful accuracy ─────────────────────────────────────
        val accuracy = if (location.hasAccuracy()) location.accuracy else 30f
        if (accuracy > MAX_ACCURACY_M) {
            // Never record a bad coordinate. Doppler speed is independent of horizontal
            // accuracy, so corroborated vehicle motion may only refresh the stop timer.
            val dopplerKmh = if (location.hasSpeed() && location.speed >= 0f) location.speed * 3.6 else 0.0
            motion.onGpsFix(dopplerKmh, null)
            if (TrackingConfig.currentTripId(this) != null &&
                dopplerKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH && motion.isVehicle(now)
            ) lastMovedMs = now
            return
        }

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
        // Both speeds, because the fix's own Doppler reading is the one that fails at a crawl.
        val groundKmh = groundSpeedKmh(location, now)
        motion.onGpsFix(speedKmh, groundKmh)
        /**
         * How fast the phone is moving RIGHT NOW, over the last 8-30 s.
         *
         * Deliberately not avgSpeedKmh below, which is measured from the trip-start watch anchor
         * and is only meaningful when that anchor is fresh. The anchor is set on the first idle
         * fix and only re-anchored once 30 m has been covered, so after a long park it can be
         * many minutes old — and 20 m spread over eight minutes averages to nothing. The vehicle
         * gate would then never see a speed above its floor no matter how the vehicle was
         * actually moving, which is the reverse of the bug it exists to fix.
         */
        val recentKmh = maxOf(speedKmh, groundKmh ?: 0.0)
        val tripId   = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // Live position for the driver's own map while idle — the dot must move even before
            // a trip starts, or the driver stares at yesterday's endpoint while approaching their
            // assigned roads. Emit only: no DB point, no upload, no trip.
            // elapsedRealtime, not wall clock: an NTP/cell time correction that moves the clock
            // backwards must not silence idle emits for the length of the jump. locMap() is the
            // shared payload builder — it also guards a zero location.time the way every other
            // emit path does.
            val idleTick = android.os.SystemClock.elapsedRealtime()
            if (idleTick - lastIdleEmitMs >= IDLE_EMIT_MS) {
                lastIdleEmitMs = idleTick
                TrackerEvents.emit("onLocation", locMap(rawLat, rawLon, speedKmh, null, "idle", location.time))
            }

            // A poor fix must not ARM or ADVANCE the trip-start watch: with 48 m error, the
            // 30 m start distance is satisfied by jitter alone and a parked phone "starts
            // driving". The dot above still moved — only the watch ignores the fix. The idle
            // timeout still runs on this path: a phone parked in a bad-GPS garage must not
            // hold the service alive forever just because its fixes are fuzzy.
            if (accuracy > TRIP_START_MAX_ACCURACY_M) {
                if (idleStartedElapsedMs > 0L && now - idleStartedElapsedMs >= IDLE_TIMEOUT_MS) {
                    enterDormant(now)
                }
                return
            }

            // Remember the idle path (good fixes only — the accuracy gate above already ran).
            // Flushed into the trip retroactively on start, so nothing driven before the gate
            // fires is lost. Spacing-gated: a parked phone appends nothing, and occasional 5 m
            // jitter costs a stray point near the anchor, not a stream of them.
            val fixTimeMs = if (location.time > 0) location.time else wallNow
            val lastBuffered = preStartBuffer.lastOrNull()
            if (lastBuffered == null ||
                haversineMeters(lastBuffered.lat, lastBuffered.lon, rawLat, rawLon) >= PRE_START_BUFFER_SPACING_M
            ) {
                preStartBuffer.addLast(BufferedFix(
                    lat = rawLat, lon = rawLon, speedKmh = speedKmh,
                    heading = if (location.hasBearing()) location.bearing.toDouble() else null,
                    accuracy = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                    altitude = if (location.hasAltitude()) location.altitude else null,
                    timeMs = fixTimeMs,
                    elapsedMs = now,
                ))
                while (preStartBuffer.size > PRE_START_BUFFER_MAX) preStartBuffer.removeFirst()
                while (preStartBuffer.isNotEmpty() && now - preStartBuffer.first().elapsedMs > PRE_START_BUFFER_MS) {
                    preStartBuffer.removeFirst()
                }
            }

            // ── IDLE: watch for a vehicle-speed movement to start a trip ────
            if (startWatchPos == null) {
                startWatchPos  = location
                startWatchTime = now
                return
            }

            val distFromWatch = startWatchPos!!.distanceTo(location)
            val elapsedSec    = ((now - startWatchTime) / 1000.0).coerceAtLeast(0.1)
            val avgSpeedKmh   = (distFromWatch / elapsedSec) * 3.6

            // What the sensors say the phone is DOING, independent of how fast it is going.
            val vehicleConfirmed = motion.isVehicle(now)
            if (vehicleConfirmed && dormant) {
                // Promote sparse monitoring to road-quality GPS as soon as sensor fusion sees a
                // vehicle, even when Play Services never emitted an IN_VEHICLE transition.
                dormant = false
                motion.setLowPower(false)
                TrackingConfig.setIdleSince(this, wallNow)
                idleStartedElapsedMs = now
                applyCadence(now)
            }

            // Adaptive: a start distance must beat the fix's error radius with margin, or
            // 40 m of jitter at 40 m accuracy reads as a 40 m drive.
            val speedGateReach   = distFromWatch >= maxOf(TRIP_START_DISTANCE_M, accuracy * 1.5f)
            val vehicleGateReach = distFromWatch >= maxOf(TRIP_START_VEHICLE_DISTANCE_M, accuracy * 2f)

            if (speedGateReach || vehicleGateReach) {
                // Three gates in.
                //
                // FAST is the original: a normal pull-away clears 10 km/h within the first 30 m.
                // It now also wants a REASON to believe this is a vehicle, because a runner can
                // hold that average over 30 m. Any of three will do, and the third is the usual
                // one: the accelerometer is alive and sees nothing walking. Note what does NOT
                // veto here — a "walking" verdict. At 10 km/h that verdict is wrong by
                // construction, and must not be allowed to cost a trip.
                //
                // SLOW is for congestion, where no stretch ever reaches 10 km/h: enough
                // accumulated ground at a crawl also counts, provided nothing recently said
                // "on foot" AND something positively says "vehicle". That requirement was
                // unaffordable before MotionClassifier existed — the only witness was Play
                // Services, which goes quiet through exactly the crawls that need it, which is
                // why this gate ran on a bare veto (see FOOT_VETO_MS) and measured 33 km against
                // a reference app's 43. With a sensor verdict available in seconds, requiring
                // one costs nothing and keeps pedestrians out.
                //
                // VEHICLE is the new one, and it asks a different question entirely: not "is
                // this fast enough to be driving" but "is this phone in a vehicle". When the
                // sensors say it is, TRIP_START_VEHICLE_DISTANCE_M of movement at barely above
                // a standstill starts the trip — 1 km/h of creep included.
                val fastStart = speedGateReach &&
                    avgSpeedKmh >= TRIP_START_MIN_SPEED_KMH &&
                    (
                        vehicleConfirmed ||
                        avgSpeedKmh >= 20.0 ||
                        (motion.hasUsableGaitWindow(now) && !motion.isRunningOnFoot(now))
                    )

                // The foot veto still stands on its own: a fresh ON_FOOT shuts the slow gate
                // even if something else claims a vehicle. FOOT_VETO_MS explains why it is
                // deliberately short-lived.
                val footRecently = TrackingConfig.lastActivity(this) == TrackingConfig.ACTIVITY_FOOT &&
                    wallNow - TrackingConfig.lastActivityAt(this) < FOOT_VETO_MS
                val vehicleRecently = TrackingConfig.lastActivity(this) == TrackingConfig.ACTIVITY_VEHICLE &&
                    wallNow - TrackingConfig.lastActivityAt(this) < FOOT_VETO_MS
                val slowStart = speedGateReach &&
                    avgSpeedKmh >= TRIP_START_SLOW_MIN_SPEED_KMH &&
                    distFromWatch >= TRIP_START_SLOW_DISTANCE_M &&
                    !footRecently && (vehicleConfirmed || vehicleRecently)

                val vehicleStart = vehicleConfirmed &&
                    vehicleGateReach &&
                    accuracy <= TRIP_START_VEHICLE_MAX_ACCURACY_M &&
                    recentKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH

                if (fastStart || slowStart || vehicleStart) {
                    // ── START TRIP ───────────────────────────────────────────
                    val newId = UUID.randomUUID().toString()
                    TrackingConfig.setCurrentTripId(this, newId)
                    TrackingConfig.setTripStartedAt(this, wallNow)
                    tripStartedElapsedMs = now
                    TrackingConfig.setIdleSince(this, 0L)
                    acquireWakeLock()

                    lastRecordedLat  = rawLat
                    lastRecordedLon  = rawLon
                    lastRecordedAtMs = now
                    hasLastRecorded  = true
                    lastMovedMs      = now
                    lastHeartbeatMs  = now
                    startWatchPos    = null
                    recentSpeeds.clear()
                    val gate = when {
                        fastStart -> "fast"
                        slowStart -> "slow"
                        else      -> "vehicle"
                    }

                    // Flush the buffered approach BEFORE the start point: every good fix since
                    // the watch anchored becomes part of the trip, with its original timestamp,
                    // so the server's startedAt (the earliest point in the batch) is when the
                    // movement began — not when the gate finally recognised it.
                    var previousBuffered: BufferedFix? = null
                    for (b in preStartBuffer) {
                        if (b.elapsedMs < startWatchTime || b.elapsedMs >= now) continue
                        val previous = previousBuffered
                        if (previous != null) {
                            val d = haversineMeters(previous.lat, previous.lon, b.lat, b.lon)
                            val minMove = maxOf(8f, ((b.accuracy ?: 30.0) * 0.75).toFloat())
                            if (d < minMove) continue // stationary jitter, not an approach leg
                            val seconds = ((b.elapsedMs - previous.elapsedMs).coerceAtLeast(1L)) / 1000.0
                            if ((d / seconds) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) continue
                        }
                        db.insert(QueuedPoint(
                            clientId     = UUID.randomUUID().toString(),
                            clientTripId = newId,
                            lat          = b.lat,
                            lon          = b.lon,
                            speedKmh     = b.speedKmh,
                            heading      = b.heading,
                            accuracy     = b.accuracy,
                            altitude     = b.altitude,
                            batteryLevel = batteryLevel(),
                            isMoving     = b.speedKmh > 1.0,
                            recordedAt   = iso(b.timeMs),
                            tripStatus   = "active",
                        ))
                        previousBuffered = b
                    }
                    preStartBuffer.clear()

                    savePoint(rawLat, rawLon, location, speedKmh, newId, "active", wallNow)
                    TrackerEvents.emit("onTripStart", mapOf(
                        "tripId" to newId,
                        "recordedAt" to iso(if (location.time > 0) location.time else wallNow)
                    ))
                    TrackerEvents.emit("onLocation",  locMap(rawLat, rawLon, speedKmh, newId, "active", location.time))
                    emitState("tracking")
                    updateNotification("Trip started ($gate) • ${speedKmh.roundToInt()} km/h")
                    applyCadence(now)
                    triggerUpload()
                } else if (speedGateReach && avgSpeedKmh < TRIP_START_SLOW_MIN_SPEED_KMH &&
                           !(vehicleConfirmed && recentKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH)) {
                    // Slower than any crawl worth calling driving — drift, not a trip. Re-anchor
                    // so the watch measures fresh. The exception is a vehicle that is genuinely
                    // moving right now: on a fuzzy fix the vehicle gate needs more than 30 m
                    // (accuracy * 2), so re-anchoring at 30 m would throw the creep's accumulated
                    // ground away just short of the gate, every time, forever.
                    startWatchPos  = location
                    startWatchTime = now
                }
                // Between the gates: a genuine crawl. Deliberately NOT re-anchored — the old
                // reset here is why a jammed street never started a trip: every 30 m the average
                // came in under 10 km/h and the accumulated distance was thrown away. Keeping the
                // anchor lets the crawl keep building toward the slow gate.
            } else {
                // Nothing has moved far enough for any gate. The ticker checks this too, so the
                // service still self-terminates when GPS goes quiet entirely.
                if (idleStartedElapsedMs > 0L && now - idleStartedElapsedMs >= IDLE_TIMEOUT_MS) {
                    enterDormant(now)
                }
            }

        } else {
            // ── TRACKING: record every POINT_DISTANCE_M of real movement ────
            if (!hasLastRecorded) {
                lastRecordedLat = rawLat
                lastRecordedLon = rawLon
                lastRecordedAtMs = now
                hasLastRecorded = true
                lastMovedMs     = now
                return
            }

            val distFromLast = haversineMeters(
                lastRecordedLat, lastRecordedLon, rawLat, rawLon
            )

            // Recording is decided by MOVEMENT, and movement has three witnesses, any one of
            // which is enough: the activity model says not-STILL; GPS speed shows a real crawl;
            // or the position itself has displaced past the fix's own error radius. The third is
            // the load-bearing one in dense traffic — a dead-slow crawl reads as STILL to the
            // activity model AND as ~0 km/h to Doppler at the same time (madhav, 2026-09-07:
            // 33 min at 14 km/h avg produced 19 points because both said "parked"), and points
            // not being recorded also meant lastMovedMs never advanced, so the 10-minute
            // no-move timer could end a trip that was inching forward the whole time. Ten real
            // metres of displacement is something neither model can veto.
            //
            // A FOURTH witness, and the one that matters below ~2 km/h: the sensor classifier
            // says this is a vehicle and the sliding ground-speed baseline says it is moving.
            //
            // Without it, a crawl slower than RECORD_MOVING_SPEED_KMH with Activity Recognition
            // reporting STILL falls back to the displacement witness, which needs
            // max(10 m, 1.5x accuracy) before it will admit any movement happened. At 1 km/h and
            // 12 m accuracy that is 65 SECONDS between recorded points — and the server splits a
            // trace wherever two fixes are more than MAP_MATCH_SPLIT_GAP_SECONDS (45 s) apart,
            // then discards any run left holding fewer than two points. So the exact stretches
            // the vehicle start gate was built to capture were recorded, uploaded, and then
            // dropped by the matcher: no snapped road line, and no matched distance.
            //
            // This witness lets the 8 s time trigger apply instead, which puts the same crawl at
            // 14-36 s between points — comfortably inside the split threshold. It cannot fire on
            // a parked vehicle: it needs a VEHICLE verdict AND real displacement over an 8-30 s
            // baseline, which is the same evidence the trip-start gate already trusts, and the
            // time trigger still enforces its own accuracy-scaled displacement floor underneath.
            val displacementMoving = distFromLast >= maxOf(POINT_DISTANCE_M, accuracy * 1.5f)
            val moving = displacementMoving ||
                !TrackingConfig.isStill(this) ||
                speedKmh >= RECORD_MOVING_SPEED_KMH ||
                (motion.isVehicle(now) && recentKmh >= TRIP_START_VEHICLE_MIN_SPEED_KMH)
            val dtMs = if (lastRecordedAtMs > 0L) now - lastRecordedAtMs else Long.MAX_VALUE
            // Distance OR time trigger. Distance stops fast roads over-sampling; the time trigger
            // keeps slow/congested roads dense so the matcher can snap them to the street grid.
            // Its displacement floor scales with the fix's error radius: a parked phone with
            // noisy fixes must not mint a jitter point every 8 s — each one would also reset the
            // 10-minute stop timer and keep a parked trip alive forever.
            val distTrigger = distFromLast >= POINT_DISTANCE_M
            val timeTrigger = dtMs >= RECORD_MIN_INTERVAL_MS &&
                distFromLast >= maxOf(RECORD_MIN_MOVE_M, accuracy * 0.5f)
            if (moving && (distTrigger || timeTrigger)) {
                // Teleport guard: a jump implying an impossible speed is multipath, not a road.
                if (lastRecordedAtMs > 0L) {
                    val dtSec = (dtMs.coerceAtLeast(1L)) / 1000.0
                    if ((distFromLast / dtSec) * 3.6 > MAX_PLAUSIBLE_SPEED_KMH) return
                }

                lastRecordedLat  = rawLat
                lastRecordedLon  = rawLon
                lastRecordedAtMs = now
                lastMovedMs      = now
                lastHeartbeatMs  = now

                savePoint(rawLat, rawLon, location, speedKmh, tripId, "active", wallNow)
                TrackerEvents.emit("onLocation", locMap(rawLat, rawLon, speedKmh, tripId, "active", location.time))
                updateNotification("Trip • ${speedKmh.roundToInt()} km/h")
                // Deliberately NO upload here. The point is in SQLite; uploadRunnable batches it
                // with its neighbours on the next window. Uploading per fix is what produced one
                // HTTP request every 3 s, kept the cellular radio permanently awake, and made the
                // handsets run hot.
                applyCadence(now)
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
        val now = SystemClock.elapsedRealtime()
        val wallNow = System.currentTimeMillis()

        // The MOVING -> STATIONARY direction is only ever noticed here: it is defined by the
        // ABSENCE of movement, so no GPS callback will announce it. (The reverse direction is
        // applied straight from processFix, so pulling away is immediate rather than waiting out
        // a tick.)
        applyCadence(now)

        // Play Services can accept a location request and then simply never deliver — it is
        // absent, disabled or too old. Nothing reports that: requestLocationUpdates returns a
        // Task that never completes and the service looks perfectly healthy while recording
        // nothing. Silence is the only symptom, so silence is what is watched for.
        if (!legacyProviderActive && lastFixElapsedMs > 0L &&
            now - lastFixElapsedMs >= NO_FIX_FALLBACK_MS
        ) {
            Log.w("JSANTracking", "No fix for ${(now - lastFixElapsedMs) / 1000}s — falling back")
            startLegacyLocationUpdates(currentGpsIntervalMs())
            lastFixElapsedMs = now
        }

        // Daylight gating removed: tracking runs at any hour now. It used to end the active trip
        // and pause until sunrise, so a night shift produced no data at all — and the resulting
        // silence let the server watchdog close the trip, after which the device kept sending
        // points into a closed trip and the driver disappeared from Live tracking entirely.

        val tripId = TrackingConfig.currentTripId(this)

        if (tripId == null) {
            // Surface what the sensors think while waiting. Two jobs: it is the only way to see
            // the classifier's verdict in the field without a debug build, and calling it here
            // keeps the score evaluating on the ticker even on a phone with no accelerometer,
            // where nothing else would drive it between GPS fixes.
            updateNotification("Waiting for movement… • " + motion.describe(now))

            // Idle — check timeout so the service stops if nobody drives.
            if (idleStartedElapsedMs > 0L && now - idleStartedElapsedMs >= IDLE_TIMEOUT_MS) {
                enterDormant(now)
            }
            return
        }

        // Hard cap: a "trip" running past TRIP_MAX_DURATION_MS is a forgotten session. End it
        // now — the server snaps it, and the next movement starts a fresh trip cleanly.
        if (tripStartedElapsedMs > 0L && now - tripStartedElapsedMs >= TRIP_MAX_DURATION_MS) {
            endTrip(tripId, now, wallNow)
            return
        }

        // Active trip — has anything been recorded recently? Every recorded point refreshes
        // lastMovedMs, so this is "10 minutes without a single recordable metre of movement".
        if (lastMovedMs > 0L && now - lastMovedMs >= TRIP_END_NO_MOVE_MS) {
            // The full grace passed at a dead stop → the vehicle is genuinely parked. Any real
            // movement inside the grace resets the clock and the trip simply continues.
            endTrip(tripId, now, wallNow)
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
                "recordedAt" to iso(wallNow)
            ))
            val stoppedMin = ((now - lastMovedMs) / 60_000L).toInt()
            updateNotification(if (stoppedMin > 0) "Stopped • $stoppedMin min" else "Stopped")
        }
    }

    // ── Trip end ──────────────────────────────────────────────────────────────

    private fun endTrip(tripId: String, now: Long, wallNow: Long = System.currentTimeMillis()) {
        // The end marker rides the last recorded coordinates — which, after a START_STICKY
        // restart that never saw a fix, are still (0.0, 0.0). Null island is inside the server's
        // coordinate range check, so it used to be accepted, become lastLocation/endLocation and
        // add a ~5,000 km phantom leg to the raw distance. With no trustworthy position there is
        // no end marker; the server's dead-trip watchdog closes the trip instead.
        if (hasLastRecorded) {
            insertPoint(lastRecordedLat, lastRecordedLon, 0.0, tripId, "ended", wallNow)
        }
        TrackingConfig.setCurrentTripId(this, null)
        TrackingConfig.setTripStartedAt(this, 0L)
        TrackingConfig.setIdleSince(this, wallNow)
        idleStartedElapsedMs = now
        tripStartedElapsedMs = 0L
        dormant = false
        motion.setLowPower(false)
        releaseWakeLock()
        hasLastRecorded = false
        lastMovedMs     = 0L
        lastHeartbeatMs = 0L
        groundRefLoc    = null
        groundRefMs     = 0L
        lastGroundKmh   = null
        startWatchPos   = null
        startWatchTime  = 0L
        recentSpeeds.clear()
        preStartBuffer.clear()
        triggerUpload()
        TrackerEvents.emit("onTripEnd", mapOf("tripId" to tripId, "recordedAt" to iso(wallNow)))
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

    /**
     * Speed measured over a SLIDING 8-30 s baseline, for MotionClassifier only.
     *
     * computeSpeedKmh above prefers the fix's own Doppler reading, which is the right choice for
     * the recorded route but useless to the classifier at the speeds that matter here: below
     * roughly 2 km/h most chipsets simply report zero, which is exactly what a creeping vehicle
     * looks like and exactly the case the vehicle gate exists to catch. Displacement over tens
     * of seconds does not have that floor.
     *
     * The reference point slides rather than being fixed, because a stale one is just as wrong
     * in the other direction: anchoring at the start of a twenty-minute park would average a
     * pull-away down to nothing. The last computed value is reused between recomputations so
     * every fix carries the current estimate instead of dropping back to a zero Doppler reading
     * and dragging the classifier's percentile down with it.
     */
    private fun groundSpeedKmh(location: Location, now: Long): Double? {
        val ref = groundRefLoc
        if (ref == null || groundRefMs == 0L) {
            groundRefLoc = location
            groundRefMs  = now
            return null
        }
        val elapsedMs = now - groundRefMs
        if (elapsedMs < GROUND_REF_MIN_MS) {
            // Baseline too short to beat jitter — reuse the last good estimate while it is fresh.
            return if (now - lastGroundAtMs <= GROUND_REF_MAX_MS * 2) lastGroundKmh else null
        }
        val kmh = (ref.distanceTo(location) / (elapsedMs / 1000.0)) * 3.6
        lastGroundKmh  = kmh
        lastGroundAtMs = now
        if (elapsedMs >= GROUND_REF_MAX_MS) {
            groundRefLoc = location
            groundRefMs  = now
        }
        return kmh
    }

    private fun batteryLevel(): Double? {
        val bm = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val lvl = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (lvl in 0..100) lvl / 100.0 else null
    }

    private fun triggerUpload() {
        Uploader.schedule(applicationContext)
    }

    /**
     * Keep a cheap motion watch instead of stopping completely. A hard stop made a 1 km/h
     * background departure impossible to observe when Play Services called it STILL/UNKNOWN.
     */
    private fun enterDormant(now: Long) {
        if (TrackingConfig.currentTripId(this) != null || dormant) return
        dormant = true
        TrackingConfig.setIdleSince(this, System.currentTimeMillis())
        idleStartedElapsedMs = now
        releaseWakeLock()
        // Keep watching for a departure, just far more cheaply — see MotionClassifier.setLowPower.
        motion.setLowPower(true)
        emitState("dormant")
        updateNotification("Low-power vehicle watch")
        applyCadence(now)
    }

    // ── Location + activity registration ─────────────────────────────────────

    private fun startLocationUpdates(
        intervalMs: Long = LOCATION_INTERVAL_MS,
        priority: Int = Priority.PRIORITY_HIGH_ACCURACY,
    ) {
        if (legacyProviderActive) {
            startLegacyLocationUpdates(intervalMs)
            return
        }
        val req = LocationRequest.Builder(priority, intervalMs)
            // Never faster than FASTEST_MS even if another app is requesting rapid fixes; at the
            // stationary rate, do not accept a fix more than twice as often as asked for.
            .setMinUpdateIntervalMillis(maxOf(FASTEST_MS, intervalMs / 2))
            .setMinUpdateDistanceMeters(0f)
            .build()
        try {
            fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
                // Play Services present but refusing (missing, disabled, out of date). The Task
                // is the only place this is reported — nothing throws.
                .addOnFailureListener { e ->
                    Log.w("JSANTracking", "Fused provider unavailable: ${e.message}")
                    startLegacyLocationUpdates(intervalMs)
                }
        } catch (_: SecurityException) {
            // The location permission was revoked while running. Do NOT stopSelf: the service
            // dying here is invisible to the driver and there is no path back until they happen
            // to reopen the app. Stay up, say so, and resume when the grant returns.
            emitState("permission_required")
            updateNotification("Location permission needed — open the app")
        } catch (e: Exception) {
            Log.w("JSANTracking", "Fused request threw: ${e.message}")
            startLegacyLocationUpdates(intervalMs)
        }
    }

    /**
     * The provider of last resort: android.location.LocationManager, which every Android device
     * has whether or not Google's are installed.
     *
     * It has no fused sensor blending and no batching, so it is a genuine downgrade in both
     * accuracy and battery — which is why it is never the first choice. It is still the
     * difference between a handset that records a shift and one that records nothing.
     */
    private fun startLegacyLocationUpdates(intervalMs: Long) {
        try {
            val lm = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return
            try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
            lm.removeUpdates(legacyListener)
            val provider = when {
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
                else -> {
                    updateNotification("Turn on Location to record trips")
                    return
                }
            }
            lm.requestLocationUpdates(provider, intervalMs, 0f, legacyListener, Looper.getMainLooper())
            if (!legacyProviderActive) {
                legacyProviderActive = true
                Log.i("JSANTracking", "Switched to platform LocationManager ($provider)")
                emitState("fallback_provider")
            }
        } catch (_: SecurityException) {
            emitState("permission_required")
            updateNotification("Location permission needed — open the app")
        } catch (e: Exception) {
            Log.w("JSANTracking", "Legacy provider failed: ${e.message}")
        }
    }

    private fun stopLegacyLocationUpdates() {
        try {
            (getSystemService(Context.LOCATION_SERVICE) as? LocationManager)
                ?.removeUpdates(legacyListener)
        } catch (_: Exception) {}
    }

    // ── Adaptive cadence ──────────────────────────────────────────────────────

    /**
     * Two rates, chosen by whether the vehicle has moved recently: GPS sampling and upload
     * batching. Both are re-evaluated on every fix and on every tick, but only re-applied when the
     * mode actually changes — re-registering a LocationRequest is not free, and doing it per fix
     * would cost more than it saves.
     */
    private enum class Cadence { MOVING, STATIONARY, DORMANT }

    private var cadence: Cadence? = null

    private val uploadTicker = Handler(Looper.getMainLooper())
    private val uploadRunnable = object : Runnable {
        override fun run() {
            triggerUpload()
            uploadTicker.postDelayed(this, uploadIntervalMs())
        }
    }

    private fun uploadIntervalMs(): Long =
        if (cadence == Cadence.MOVING) UPLOAD_INTERVAL_MOVING_MS else UPLOAD_INTERVAL_STATIONARY_MS

    /**
     * Health-heartbeat cadence. Frequent while a trip is live, because that is when the panel
     * needs to know the app is alive; rare otherwise, because nothing it reports changes while a
     * phone sits in a parked vehicle overnight.
     */
    /** The GPS interval the current cadence calls for — used when re-registering a provider. */
    private fun currentGpsIntervalMs(): Long = when (cadence) {
        Cadence.MOVING -> LOCATION_INTERVAL_MS
        Cadence.DORMANT -> LOCATION_INTERVAL_DORMANT_MS
        else -> LOCATION_INTERVAL_STATIONARY_MS
    }

    private fun heartbeatIntervalMs(): Long = when {
        TrackingConfig.currentTripId(this) != null -> HEARTBEAT_ACTIVE_MS
        dormant -> HEARTBEAT_DORMANT_MS
        else -> HEARTBEAT_IDLE_MS
    }

    /** Moving = a trip is open AND something moved within STATIONARY_AFTER_MS. */
    private fun applyCadence(now: Long) {
        val tripOpen = TrackingConfig.currentTripId(this) != null
        val movedRecently = lastMovedMs > 0L && now - lastMovedMs < STATIONARY_AFTER_MS
        val wanted = when {
            tripOpen && movedRecently -> Cadence.MOVING
            !tripOpen && dormant -> Cadence.DORMANT
            else -> Cadence.STATIONARY
        }
        if (wanted == cadence) return

        cadence = wanted
        val gpsMs = when (wanted) {
            Cadence.MOVING -> LOCATION_INTERVAL_MS
            Cadence.STATIONARY -> LOCATION_INTERVAL_STATIONARY_MS
            Cadence.DORMANT -> LOCATION_INTERVAL_DORMANT_MS
        }
        val priority = if (wanted == Cadence.DORMANT)
            Priority.PRIORITY_BALANCED_POWER_ACCURACY
        else Priority.PRIORITY_HIGH_ACCURACY
        try { fused.removeLocationUpdates(locationCallback) } catch (_: Exception) {}
        startLocationUpdates(gpsMs, priority)

        // Restart the upload ticker on the new interval rather than waiting out the old one, so
        // pulling away from a stop does not sit on a 30 s upload gap.
        uploadTicker.removeCallbacks(uploadRunnable)
        uploadTicker.postDelayed(uploadRunnable, uploadIntervalMs())
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

    /**
     * Continuous activity sampling — the confidence-bearing counterpart to the transition
     * registration above. Transitions wake the service; these feed MotionClassifier while it
     * runs, and are released in onDestroy because nothing consumes them once it stops.
     *
     * A distinct request code (101) from the transition PendingIntent (100): sharing one would
     * make the second registration overwrite the first.
     */
    private fun registerActivityUpdates() {
        try {
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            val pi = PendingIntent.getBroadcast(
                this, 101, Intent(this, ActivityUpdatesReceiver::class.java), flags
            )
            activityUpdatesPi = pi
            ActivityRecognition.getClient(this)
                .requestActivityUpdates(ACTIVITY_UPDATE_INTERVAL_MS, pi)
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
        // Created once per process. It used to be recreated on every single update — which, with
        // the idle ticker refreshing the text every 20 s, meant a channel write and a
        // PackageManager query three times a minute for the entire life of the service.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !notificationChannelReady) {
            val ch = NotificationChannel(CHANNEL_ID, "Trip tracking", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
            notificationChannelReady = true
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
        // Posting the same text again costs a binder round trip and a system-server notification
        // rebuild, and shows the driver nothing new.
        if (text == lastNotificationText) return
        lastNotificationText = text
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, notification(text))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun iso(ms: Long): String = isoFmt.format(Date(ms))

    private fun emitState(state: String) =
        TrackerEvents.emit("onStateChange", mapOf("state" to state))

    private fun locMap(
        lat: Double, lon: Double, speedKmh: Double,
        tripId: String?, status: String, locationTime: Long,
    ) = mapOf(
        "lat"        to lat,
        "lon"        to lon,
        "speedKmh"   to speedKmh,
        "tripId"     to tripId,
        "tripStatus" to status,
        "recordedAt" to iso(if (locationTime > 0) locationTime else System.currentTimeMillis()),
    )
}
