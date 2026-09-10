package expo.modules.vehicletracker

import android.content.Context

/**
 * Durable config + trip state, kept in SharedPreferences so the service survives
 * process death and device reboot without needing the JS layer to be alive.
 */
object TrackingConfig {
    private const val PREFS = "jsan_tracker_prefs"

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(ctx: Context, apiBaseUrl: String, token: String, driverId: String) {
        prefs(ctx).edit()
            .putString("apiBaseUrl", apiBaseUrl.trimEnd('/'))
            .putString("token", token)
            .putString("driverId", driverId)
            .apply()
    }

    fun setEnabled(ctx: Context, enabled: Boolean) =
        prefs(ctx).edit().putBoolean("enabled", enabled).apply()

    fun isEnabled(ctx: Context) = prefs(ctx).getBoolean("enabled", false)
    fun apiBaseUrl(ctx: Context): String? = prefs(ctx).getString("apiBaseUrl", null)
    fun token(ctx: Context): String? = prefs(ctx).getString("token", null)
    fun driverId(ctx: Context): String? = prefs(ctx).getString("driverId", null)

    // ---- Trip state machine (persisted so a killed/restarted service resumes cleanly) ----
    fun currentTripId(ctx: Context): String? = prefs(ctx).getString("currentTripId", null)
    fun setCurrentTripId(ctx: Context, id: String?) =
        prefs(ctx).edit().putString("currentTripId", id).apply()

    /** epoch ms when the current trip started (0 = no trip). Drives the max-duration cap. */
    fun tripStartedAt(ctx: Context): Long = prefs(ctx).getLong("tripStartedAt", 0L)
    fun setTripStartedAt(ctx: Context, ms: Long) =
        prefs(ctx).edit().putLong("tripStartedAt", ms).apply()

    /** epoch ms when speed first dropped to ~0 within the current trip (0 = moving). */
    fun stillSince(ctx: Context): Long = prefs(ctx).getLong("stillSince", 0L)
    fun setStillSince(ctx: Context, ms: Long) = prefs(ctx).edit().putLong("stillSince", ms).apply()

    /** epoch ms when we entered idle (service start / last trip end). Drives the 20-min timeout. */
    fun idleSince(ctx: Context): Long = prefs(ctx).getLong("idleSince", 0L)
    fun setIdleSince(ctx: Context, ms: Long) = prefs(ctx).edit().putLong("idleSince", ms).apply()

    /**
     * Set by ActivityTransitionReceiver when STILL is entered/exited.
     * When true the service treats effective speed as 0 regardless of GPS output,
     * which kills false movement readings from GPS drift while standing still.
     */
    fun isStill(ctx: Context): Boolean = prefs(ctx).getBoolean("activityStill", false)
    fun setStill(ctx: Context, still: Boolean) =
        prefs(ctx).edit().putBoolean("activityStill", still).apply()

    /**
     * What the activity model last said the device was doing, coarsely: in a vehicle (car or
     * bicycle) or on foot. Written by ActivityTransitionReceiver, read by the slow trip-start
     * gate — 100 m of creep is a traffic jam in a vehicle and a stroll on foot, and only this
     * signal tells them apart. Null until Play Services delivers a first verdict; the slow gate
     * stays closed while it is.
     */
    const val ACTIVITY_VEHICLE = "vehicle"
    const val ACTIVITY_FOOT = "foot"
    fun lastActivity(ctx: Context): String? = prefs(ctx).getString("lastActivity", null)
    /** When that verdict landed — the slow gate's on-foot veto expires (FOOT_VETO_MS). */
    fun lastActivityAt(ctx: Context): Long = prefs(ctx).getLong("lastActivityAt", 0L)
    fun setLastActivity(ctx: Context, kind: String) =
        prefs(ctx).edit()
            .putString("lastActivity", kind)
            .putLong("lastActivityAt", System.currentTimeMillis())
            .apply()

    /**
     * Continuous activity-recognition confidences (0-100), written by ActivityUpdatesReceiver
     * every ACTIVITY_UPDATE_INTERVAL_MS. Distinct from lastActivity above, which only records
     * transition EDGES and carries no confidence: MotionClassifier needs to know how sure the
     * model is and how long ago it said so, because a 40% guess and a 90% call are not the same
     * evidence, and a verdict from ten minutes ago is not evidence at all.
     */
    fun setActivityConfidence(ctx: Context, vehicle: Int, foot: Int) =
        prefs(ctx).edit()
            .putInt("arVehicleConfidence", vehicle)
            .putInt("arFootConfidence", foot)
            .putLong("arConfidenceAt", System.currentTimeMillis())
            .apply()

    fun activityVehicleConfidence(ctx: Context): Int = prefs(ctx).getInt("arVehicleConfidence", 0)
    fun activityFootConfidence(ctx: Context): Int = prefs(ctx).getInt("arFootConfidence", 0)
    fun activityConfidenceAt(ctx: Context): Long = prefs(ctx).getLong("arConfidenceAt", 0L)

    // ---- Timezone / daylight tracking ----

    /** IANA timezone ID auto-detected from the device (e.g. "Asia/Kolkata"). */
    fun timezoneId(ctx: Context): String? = prefs(ctx).getString("timezoneId", null)
    fun setTimezoneId(ctx: Context, tzId: String) =
        prefs(ctx).edit().putString("timezoneId", tzId).apply()

    /** Last known latitude — used for sunrise/sunset calculation. */
    fun lastLat(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("lastLat", Double.NaN.toBits()))
    fun setLastLat(ctx: Context, lat: Double) =
        prefs(ctx).edit().putLong("lastLat", lat.toBits()).apply()

    /** Last known longitude — used for sunrise/sunset calculation. */
    fun lastLon(ctx: Context): Double =
        Double.fromBits(prefs(ctx).getLong("lastLon", Double.NaN.toBits()))
    fun setLastLon(ctx: Context, lon: Double) =
        prefs(ctx).edit().putLong("lastLon", lon.toBits()).apply()

    /** Whether daylight-only tracking is enabled (default: true). */
    /**
     * Retained only so an existing install with the old preference stored does not break; nothing
     * reads it to gate tracking any more. Defaults to false: tracking runs at any hour, because
     * pausing overnight lost night-shift data outright and the silence made the server watchdog
     * close the trip, which left the driver invisible on Live tracking.
     */
    fun isDaylightOnly(ctx: Context): Boolean = prefs(ctx).getBoolean("daylightOnly", false)
    fun setDaylightOnly(ctx: Context, enabled: Boolean) =
        prefs(ctx).edit().putBoolean("daylightOnly", enabled).apply()
}
