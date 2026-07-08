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

    /** epoch ms when speed first dropped to ~0 within the current trip (0 = moving). */
    fun stillSince(ctx: Context): Long = prefs(ctx).getLong("stillSince", 0L)
    fun setStillSince(ctx: Context, ms: Long) = prefs(ctx).edit().putLong("stillSince", ms).apply()

    /** epoch ms when we entered idle (service start / last trip end). Drives the 20-min timeout. */
    fun idleSince(ctx: Context): Long = prefs(ctx).getLong("idleSince", 0L)
    fun setIdleSince(ctx: Context, ms: Long) = prefs(ctx).edit().putLong("idleSince", ms).apply()
}
