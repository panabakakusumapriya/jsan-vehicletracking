package expo.modules.vehicletracker

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
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

        if (!NetworkUtil.isOnline(ctx)) return

        lastSentMs = now

        // Fire-and-forget on a background thread
        Thread {
            try {
                val body = "{}".toRequestBody("application/json; charset=utf-8".toMediaType())
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
}
