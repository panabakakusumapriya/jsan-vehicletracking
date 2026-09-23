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
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Sends a lightweight heartbeat to POST /api/app-activity/heartbeat every ~30s.
 * Fire-and-forget: no retry, no queue. If it fails, the next tick retries.
 * The server uses this to determine if the driver's app is alive.
 */
object HeartbeatSender {
    private const val TAG = "JSANHeartbeat"

    /** Fallback interval when the caller does not specify one (ms). */
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
    private val executor = Executors.newSingleThreadExecutor()
    private val inFlight = AtomicBoolean(false)

    /**
     * Send a heartbeat if enough time has passed since the last one.
     * Called from the TrackingService ticker (every 20s). Skips silently
     * if called too soon or if config is missing.
     */
    fun sendIfDue(ctx: Context, minIntervalMs: Long = MIN_INTERVAL_MS) {
        val now = System.currentTimeMillis()
        if (now - lastSentMs < minIntervalMs) return

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

        // Fire-and-forget on one coalesced background worker. The application context, not the
        // service's: this outlives the call that started it.
        val appCtx = ctx.applicationContext
        if (!inFlight.compareAndSet(false, true)) return
        executor.execute {
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
                        applySettings(appCtx, resp.body?.string())
                    } else {
                        Log.w(TAG, "Heartbeat failed: HTTP ${resp.code}")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Heartbeat error: ${e.message}")
            } finally {
                inFlight.set(false)
            }
        }
    }

    /**
     * The heartbeat RESPONSE carries the driver's project-level tracking settings.
     *
     * This is the only channel that reaches the engine while it is doing its job: the service
     * runs for a whole shift in the background, and a setting delivered only through the JS
     * layer's /me call would wait for the driver to open the app — which, on a handset that
     * lives in a cradle, may be never. Here it lands within one heartbeat of an admin saving it.
     *
     * An ABSENT field is meaningful and means "this project has no override, use the built-in
     * default" — that is how clearing the box in the admin panel reaches the handset, and it is
     * also what an older server (or any server that has not deployed this yet) says.
     */
    private fun applySettings(ctx: Context, body: String?) {
        if (body.isNullOrBlank()) return
        try {
            val json = JSONObject(body)
            val minutes =
                if (json.has("tripEndAfterMinutes") && !json.isNull("tripEndAfterMinutes")) {
                    json.optInt("tripEndAfterMinutes", 0)
                } else 0
            TrackingConfig.setTripEndAfterMinutes(ctx, minutes)
        } catch (e: Exception) {
            // A malformed body must never cost us the heartbeat itself — liveness is this
            // request's actual job, config delivery is a passenger.
            Log.w(TAG, "Heartbeat settings ignored: ${e.message}")
        }
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
