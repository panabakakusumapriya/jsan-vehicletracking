package expo.modules.vtstracker

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * On-device store of GPS fixes. This is the SOURCE OF TRUTH: every fix is written here
 * (in native code) the instant it arrives — independent of the JS engine, which the OS
 * freezes when the app is minimized. Rows are deleted ONLY after the server acknowledges
 * them (HTTP 2xx), so nothing is ever lost. Plain SQLiteOpenHelper (no Room/codegen) to
 * keep the build bullet-proof. All methods are @Synchronized → safe from any thread.
 */
class LocationDb(context: Context) : SQLiteOpenHelper(context.applicationContext, NAME, null, VERSION) {

  data class Row(
    val id: Long, val lat: Double, val lng: Double, val acc: Double,
    val spd: Double, val hdg: Double, val alt: Double, val ts: Long, val session: String, val gap: Int
  )

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      "CREATE TABLE loc (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL, lng REAL, acc REAL, spd REAL, " +
        "hdg REAL, alt REAL, ts INTEGER, session TEXT, gap INTEGER DEFAULT 0)"
    )
    db.execSQL("CREATE INDEX idx_id ON loc(id)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldV: Int, newV: Int) {
    // NEVER drop the queue — it may hold un-uploaded payroll points. Migrate additively only.
    // (Kept as a guarded no-op so a future schema bump can ALTER TABLE here without data loss.)
    db.execSQL("CREATE TABLE IF NOT EXISTS loc (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL, lng REAL, acc REAL, spd REAL, " +
      "hdg REAL, alt REAL, ts INTEGER, session TEXT, gap INTEGER DEFAULT 0)")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_id ON loc(id)")
  }

  @Synchronized
  fun insert(lat: Double, lng: Double, acc: Double, spd: Double, hdg: Double, alt: Double, ts: Long, session: String, gap: Int) {
    val cv = ContentValues().apply {
      put("lat", lat); put("lng", lng); put("acc", acc); put("spd", spd)
      put("hdg", hdg); put("alt", alt); put("ts", ts); put("session", session); put("gap", gap)
    }
    writableDatabase.insert("loc", null, cv)
  }

  /** Oldest un-uploaded rows, up to [limit]. */
  @Synchronized
  fun unsynced(limit: Int): List<Row> {
    val out = ArrayList<Row>()
    readableDatabase.rawQuery(
      "SELECT id,lat,lng,acc,spd,hdg,alt,ts,session,gap FROM loc ORDER BY id ASC LIMIT ?",
      arrayOf(limit.toString())
    ).use { c ->
      while (c.moveToNext()) {
        out.add(
          Row(
            c.getLong(0), c.getDouble(1), c.getDouble(2), c.getDouble(3),
            c.getDouble(4), c.getDouble(5), c.getDouble(6), c.getLong(7), c.getString(8) ?: "", c.getInt(9)
          )
        )
      }
    }
    return out
  }

  /** Delete rows the server has confirmed (2xx). */
  @Synchronized
  fun deleteIds(ids: List<Long>) {
    if (ids.isEmpty()) return
    writableDatabase.execSQL("DELETE FROM loc WHERE id IN (${ids.joinToString(",")})")
  }

  @Synchronized
  fun pending(): Int {
    readableDatabase.rawQuery("SELECT COUNT(*) FROM loc", null).use { c ->
      return if (c.moveToFirst()) c.getInt(0) else 0
    }
  }

  companion object {
    private const val NAME = "vts_tracker.db"
    private const val VERSION = 1
  }
}
