package expo.modules.vehicletracker

import android.content.Context
import android.util.Log
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Sends a lightweight heartbeat to POST /api/app-activity/heartbeat every ~30s.
 * Fire-and-forget: no retry, no queue. If it fails, the next tick retries.
 * The server uses this to determine if the driver's app is alive.
 */
object HeartbeatSender {
    private const val TAG = "JSANHeartbeat"

    /** Minimum interval between heartbeat calls (ms). */
    private const val MIN_INTERVAL_MS = 30_000L

    @Volatile
    private var lastSentMs = 0L

    /** Track if network was off so we can report it when network returns. */
    @Volatile
    private var wasNetworkOff = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    /**
     * Send a heartbeat if enough time has passed since the last one.
     * Called from the TrackingService ticker (every 20s). Skips silently
     * if called too soon or if config is missing.
     */
    fun sendIfDue(ctx: Context) {
        val now = System.currentTimeMillis()
        if (now - lastSentMs < MIN_INTERVAL_MS) return

        val base = TrackingConfig.apiBaseUrl(ctx) ?: return
        val token = TrackingConfig.token(ctx) ?: return

        if (!NetworkUtil.isOnline(ctx)) {
            wasNetworkOff = true
            return
        }

        lastSentMs = now

        val status = collectStatus(ctx)
        if (wasNetworkOff) {
            status.put("wasNetworkOff", true)
            wasNetworkOff = false
        }

        // Fire-and-forget on a background thread
        Thread {
            try {
                val body = status.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val req = Request.Builder()
                    .url("$base/api/app-activity/heartbeat")
                    .addHeader("Authorization", "Bearer $token")
                    .post(body)
                    .build()

                client.newCall(req).execute().use { resp ->
                    if (resp.isSuccessful) {
                        Log.d(TAG, "Heartbeat sent")
                    } else {
                        Log.w(TAG, "Heartbeat failed: HTTP ${resp.code}")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Heartbeat error: ${e.message}")
            }
        }.start()
    }

    private fun collectStatus(ctx: Context): JSONObject {
        val json = JSONObject()

        // GPS enabled
        try {
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            json.put("gpsOn", lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) ?: false)
        } catch (_: Exception) {
            json.put("gpsOn", false)
        }

        // Network available
        try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val net = cm?.activeNetwork
            val caps = net?.let { cm.getNetworkCapabilities(it) }
            json.put("networkOn", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ?: false)
        } catch (_: Exception) {
            json.put("networkOn", false)
        }

        // Battery restricted (power save / ignore battery optimizations)
        try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val restricted = pm?.isPowerSaveMode ?: false
            json.put("batteryRestricted", restricted)
        } catch (_: Exception) {
            json.put("batteryRestricted", false)
        }

        // Battery level
        try {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            val lvl = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (lvl in 0..100) json.put("batteryLevel", lvl)
        } catch (_: Exception) {}

        return json
    }
}
