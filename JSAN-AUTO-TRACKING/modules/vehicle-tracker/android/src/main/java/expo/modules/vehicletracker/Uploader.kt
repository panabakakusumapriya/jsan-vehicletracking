package expo.modules.vehicletracker

import android.content.Context
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
 */
object Uploader {
    private const val BATCH = 200
    private const val JSON_MT = "application/json; charset=utf-8"

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
            val base = TrackingConfig.apiBaseUrl(ctx) ?: return 0
            val token = TrackingConfig.token(ctx) ?: return 0
            if (!NetworkUtil.isOnline(ctx)) return 0

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

                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) return uploaded // retry later
                    val json = JSONObject(resp.body?.string() ?: "{}")
                    val acked = json.optJSONArray("acceptedClientIds") ?: JSONArray()
                    val ids = (0 until acked.length()).map { acked.getString(it) }
                    if (ids.isEmpty()) return uploaded // nothing acked -> avoid a tight loop
                    db.deleteIds(ids)
                    uploaded += ids.size
                }
            }
        } catch (_: Exception) {
            // Network/parse error — keep rows, retry next time.
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
