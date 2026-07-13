package expo.modules.vehicletracker

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Drains the SQLite queue to POST /api/tracking/ingest. Idempotent by design:
 * the server acks clientIds it stored (or already had), and we delete exactly those.
 * On any failure we stop and leave rows in place to retry on the next trigger.
 *
 * Reliability improvements:
 *  - Validates token/URL before attempting upload (emits JS error if missing)
 *  - Retries on server errors (5xx) up to MAX_RETRIES times with backoff
 *  - Emits onUploadError to JS so the home screen can show an indicator
 *  - Logs all failures for crash reporting / logcat debugging
 */
object Uploader {
    private const val TAG = "JSANUploader"
    private const val BATCH = 200
    private const val JSON_MT = "application/json; charset=utf-8"
    private const val MAX_RETRIES = 3

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    @Volatile
    private var running = false

    /** Returns the number of points successfully uploaded (and removed locally). */
    @Synchronized
    fun flush(ctx: Context): Int {
        if (running) return 0
        running = true
        var uploaded = 0
        try {
            val base = TrackingConfig.apiBaseUrl(ctx)
            val token = TrackingConfig.token(ctx)

            // Emit JS error if auth is missing — driver or home screen can react
            if (base.isNullOrBlank() || token.isNullOrBlank()) {
                Log.w(TAG, "Upload skipped: apiBaseUrl or token not configured")
                TrackerEvents.emit("onUploadError", mapOf(
                    "reason" to "not_configured",
                    "message" to "Tracking upload not configured — please open the app to re-authenticate."
                ))
                return 0
            }

            if (!NetworkUtil.isOnline(ctx)) {
                Log.d(TAG, "Upload skipped: device offline")
                return 0
            }

            val db = LocationDatabase(ctx)
            while (true) {
                val batch = db.batch(BATCH)
                if (batch.isEmpty()) break

                val payload = JSONObject().put("points", JSONArray().apply {
                    batch.forEach { put(pointJson(it)) }
                }).toString().toRequestBody(JSON_MT.toMediaType())

                val req = Request.Builder()
                    .url("$base/api/tracking/ingest")
                    .addHeader("Authorization", "Bearer $token")
                    .post(payload)
                    .build()

                var success = false
                var lastCode = 0
                for (attempt in 1..MAX_RETRIES) {
                    try {
                        client.newCall(req).execute().use { resp ->
                            lastCode = resp.code
                            when {
                                resp.isSuccessful -> {
                                    val json = JSONObject(resp.body?.string() ?: "{}")
                                    val acked = json.optJSONArray("acceptedClientIds") ?: JSONArray()
                                    val ids = (0 until acked.length()).map { acked.getString(it) }
                                    if (ids.isEmpty()) {
                                        // Server acked 0 — avoid tight loop, stop this batch
                                        Log.w(TAG, "Server acked 0 points in batch of ${batch.size}")
                                        success = true
                                        return uploaded
                                    }
                                    db.deleteIds(ids)
                                    uploaded += ids.size
                                    success = true
                                    Log.d(TAG, "Uploaded ${ids.size} points (total=$uploaded)")
                                }
                                resp.code == 401 || resp.code == 403 -> {
                                    // Auth problem — no point retrying, emit error
                                    Log.e(TAG, "Upload auth failure: HTTP ${resp.code}")
                                    TrackerEvents.emit("onUploadError", mapOf(
                                        "reason" to "auth_failure",
                                        "message" to "Authentication failed — please open the app to re-login.",
                                        "code" to resp.code
                                    ))
                                    return uploaded
                                }
                                else -> {
                                    // 5xx or other — retry with backoff
                                    Log.w(TAG, "Upload failed HTTP ${resp.code}, attempt $attempt/$MAX_RETRIES")
                                }
                            }
                        }
                        if (success) break
                    } catch (e: Exception) {
                        Log.w(TAG, "Upload exception attempt $attempt/$MAX_RETRIES: ${e.message}")
                    }

                    if (attempt < MAX_RETRIES) {
                        // Exponential backoff: 5s, 15s, 45s
                        Thread.sleep(5_000L * attempt)
                    }
                }

                if (!success) {
                    Log.e(TAG, "Upload failed after $MAX_RETRIES attempts (last HTTP $lastCode), keeping ${batch.size} points")
                    break // leave points in DB, retry on next trigger
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Unexpected upload error: ${e.message}", e)
        } finally {
            running = false
        }
        return uploaded
    }

    private fun pointJson(p: QueuedPoint) = JSONObject().apply {
        put("clientId", p.clientId)
        put("clientTripId", p.clientTripId)
        put("lat", p.lat)
        put("lon", p.lon)
        put("speedKmh", p.speedKmh)
        put("heading", p.heading ?: JSONObject.NULL)
        put("accuracy", p.accuracy ?: JSONObject.NULL)
        put("altitude", p.altitude ?: JSONObject.NULL)
        put("batteryLevel", p.batteryLevel ?: JSONObject.NULL)
        put("isMoving", p.isMoving)
        put("recordedAt", p.recordedAt)
        put("tripStatus", p.tripStatus)
    }
}
