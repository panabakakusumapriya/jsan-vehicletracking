package expo.modules.vtstracker

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Self-healing WATCHDOG. While tracking is meant to be active, a repeating exact alarm fires
 * every ~90s and RELAUNCHES the foreground service if an aggressive OEM (MIUI/POCO/Samsung) has
 * killed it — START_STICKY alone isn't honoured on those devices. Each tick re-arms the next
 * alarm (exact alarms are one-shot), so the chain keeps running until tracking is stopped.
 * This is the single biggest background-reliability win (matches what mature trackers do).
 */
class WatchdogReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val prefs = context.getSharedPreferences(TrackingService.PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean("active", false)) return // tracking stopped → don't restart, don't re-arm

    val restart = {
      val svc = Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_START)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
        else context.startService(svc)
      } catch (_: Throwable) {}
    }

    if (!TrackingService.isRunning) {
      restart() // service was killed (OEM / Doze / low-memory) → relaunch it
    } else {
      // Alive, but is GPS still delivering? If an active trip has had NO recorded fix for a while,
      // the fused callback has likely gone silent (OEM froze it, or the user toggled location).
      // Re-send ACTION_START — onStartCommand re-issues requestLocationUpdates (idempotent), which
      // re-subscribes the callback. lastFixTs advances on every recorded fix.
      val lastFixTs = prefs.getLong("lastFixTs", 0L)
      if (lastFixTs > 0L && System.currentTimeMillis() - lastFixTs > STALE_FIX_MS) restart()
    }
    schedule(context) // re-arm the next tick
  }

  companion object {
    private const val REQ = 8424
    private const val INTERVAL_MS = 60_000L // re-check every 60s
    // No recorded fix for this long during an active trip ⇒ the GPS callback is presumed dead and
    // we re-subscribe. >3 min tolerates ordinary stops (with the 10m distance filter a parked car
    // emits no fixes) while still catching a genuinely frozen subscription.
    private const val STALE_FIX_MS = 180_000L

    private fun pendingIntent(context: Context): PendingIntent {
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      return PendingIntent.getBroadcast(context, REQ, Intent(context, WatchdogReceiver::class.java), flags)
    }

    /** Arm the next watchdog tick. Exact when allowed, else inexact-while-idle (still fires in Doze). */
    fun schedule(context: Context) {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pi = pendingIntent(context)
      val at = System.currentTimeMillis() + INTERVAL_MS
      try {
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        if (canExact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      } catch (_: SecurityException) {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      }
    }

    /**
     * Fire the watchdog ASAP (~1.5s) — used on task removal / force-close so the foreground
     * service is relaunched in a fresh process almost immediately, instead of waiting up to a
     * full 60s tick. The alarm is registered with AlarmManager (system-level), so it survives
     * the app's process being killed when the user swipes the app away.
     */
    fun restartSoon(context: Context) {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val pi = pendingIntent(context)
      val at = System.currentTimeMillis() + 1500L
      try {
        val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        if (canExact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      } catch (_: SecurityException) {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      }
    }

    fun cancel(context: Context) {
      val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      am.cancel(pendingIntent(context))
    }
  }
}
