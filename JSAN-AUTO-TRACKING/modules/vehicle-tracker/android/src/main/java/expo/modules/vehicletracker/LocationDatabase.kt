package expo.modules.vehicletracker

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class QueuedPoint(
    val clientId: String,
    val clientTripId: String,
    val lat: Double,
    val lon: Double,
    val speedKmh: Double,
    val heading: Double?,
    val accuracy: Double?,
    val altitude: Double?,
    val batteryLevel: Double?,
    val isMoving: Boolean,
    val recordedAt: String, // ISO-8601
    val tripStatus: String   // active | ended | timed_out
)

/**
 * The offline buffer. Every location fix is written here first (native, so it works
 * even when the app is killed). The Uploader drains it and deletes acked rows.
 */
class LocationDatabase(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "jsan_tracker.db"
        private const val DB_VERSION = 1
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE points(
                clientId TEXT PRIMARY KEY,
                clientTripId TEXT,
                lat REAL, lon REAL,
                speedKmh REAL, heading REAL, accuracy REAL, altitude REAL,
                batteryLevel REAL, isMoving INTEGER,
                recordedAt TEXT, tripStatus TEXT
            )"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldV: Int, newV: Int) {
        db.execSQL("DROP TABLE IF EXISTS points")
        onCreate(db)
    }

    @Synchronized
    fun insert(p: QueuedPoint) {
        val v = ContentValues().apply {
            put("clientId", p.clientId)
            put("clientTripId", p.clientTripId)
            put("lat", p.lat); put("lon", p.lon); put("speedKmh", p.speedKmh)
            put("heading", p.heading); put("accuracy", p.accuracy); put("altitude", p.altitude)
            put("batteryLevel", p.batteryLevel); put("isMoving", if (p.isMoving) 1 else 0)
            put("recordedAt", p.recordedAt); put("tripStatus", p.tripStatus)
        }
        writableDatabase.insertWithOnConflict("points", null, v, SQLiteDatabase.CONFLICT_IGNORE)
    }

    @Synchronized
    fun batch(limit: Int): List<QueuedPoint> {
        val out = mutableListOf<QueuedPoint>()
        readableDatabase.rawQuery(
            "SELECT clientId,clientTripId,lat,lon,speedKmh,heading,accuracy,altitude,batteryLevel,isMoving,recordedAt,tripStatus FROM points ORDER BY recordedAt ASC LIMIT ?",
            arrayOf(limit.toString())
        ).use { c ->
            while (c.moveToNext()) {
                out.add(
                    QueuedPoint(
                        clientId = c.getString(0),
                        clientTripId = c.getString(1),
                        lat = c.getDouble(2),
                        lon = c.getDouble(3),
                        speedKmh = c.getDouble(4),
                        heading = if (c.isNull(5)) null else c.getDouble(5),
                        accuracy = if (c.isNull(6)) null else c.getDouble(6),
                        altitude = if (c.isNull(7)) null else c.getDouble(7),
                        batteryLevel = if (c.isNull(8)) null else c.getDouble(8),
                        isMoving = c.getInt(9) == 1,
                        recordedAt = c.getString(10),
                        tripStatus = c.getString(11)
                    )
                )
            }
        }
        return out
    }

    @Synchronized
    fun deleteIds(ids: List<String>) {
        if (ids.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            val stmt = db.compileStatement("DELETE FROM points WHERE clientId = ?")
            for (id in ids) {
                stmt.bindString(1, id)
                stmt.executeUpdateDelete()
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun count(): Int {
        readableDatabase.rawQuery("SELECT COUNT(*) FROM points", null).use { c ->
            return if (c.moveToFirst()) c.getInt(0) else 0
        }
    }
}
