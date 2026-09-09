package expo.modules.vehicletracker

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log

/**
 * Brings the tracking service back after something outside our control has killed it.
 *
 * Why this is needed at all
 * -------------------------
 * The service is a foreground service with START_STICKY, which on stock Android is enough. It is
 * not enough in this fleet's reality:
 *
 *  - Xiaomi/MIUI, Oppo/ColorOS, Vivo/FuntouchOS, Huawei/EMUI and Samsung's stricter power modes
 *    all kill foreground services of apps the user swipes out of Recents, and several of them
 *    deliberately ignore START_STICKY. A driver tidying their recents list ends their own shift.
 *  - The system kills services under memory pressure and can defer the sticky restart
 *    indefinitely.
 *  - Before this, the ONLY paths back were a device reboot, an app update, an Activity
 *    Recognition transition, or the driver reopening the app. On a handset without Play Services
 *    the third does not exist either, so tracking stayed dead — silently, with the driver
 *    believing they were being tracked — until somebody opened the app.
 *
 * An alarm survives the process dying, so it is the one mechanism that can still act after we are
 * gone. It fires every WATCHDOG_INTERVAL_MS and simply asks for the service again; if it is
 * already running that is a no-op costing microseconds.
 *
 * Why inexact alarms: setExactAndAllowWhileIdle needs SCHEDULE_EXACT_ALARM, which Google
 * restricts to alarm-clock-shaped apps and will reject at review for a tracker. The inexact
 * while-idle variant needs no permission and is delivered in the next Doze maintenance window,
 * which for a "check every so often" watchdog is exactly right.
 *
 * Every call is defensive: on Android 12+ starting a foreground service from an alarm can still
 * be refused when the app is not battery-exempt, and a throw inside a BroadcastReceiver is an
 * app crash. Failing to restart is bad; crashing while trying is worse.
 */
object ServiceWatchdog {
    private const val TAG = "JSANWatchdog"
    private const val REQ_CODE = 4712
    const val ACTION_CHECK = "expo.modules.vehicletracker.WATCHDOG_CHECK"

    /** How often to confirm the service is still alive. */
    private const val WATCHDOG_INTERVAL_MS = 15 * 60 * 1000L

    /** Delay used when we know the service just died (task swipe) and want it straight back. */
    private const val RETRY_DELAY_MS = 5_000L

    private fun alarmManager(ctx: Context) =
        ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

    private fun pendingIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx.applicationContext, WatchdogReceiver::class.java)
            .setAction(ACTION_CHECK)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT
        return PendingIntent.getBroadcast(ctx.applicationContext, REQ_CODE, intent, flags)
    }

    /** Arm the periodic check. Idempotent — re-arming just moves the next firing. */
    fun schedule(ctx: Context, delayMs: Long = WATCHDOG_INTERVAL_MS) {
        try {
            val am = alarmManager(ctx) ?: return
            val at = SystemClock.elapsedRealtime() + delayMs
            am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pendingIntent(ctx))
        } catch (e: Exception) {
            Log.w(TAG, "Could not schedule watchdog: ${e.message}")
        }
    }

    /** The service just went away and we want it back now, not at the next interval. */
    fun scheduleRetry(ctx: Context, delayMs: Long = RETRY_DELAY_MS) = schedule(ctx, delayMs)

    fun cancel(ctx: Context) {
        try { alarmManager(ctx)?.cancel(pendingIntent(ctx)) } catch (_: Exception) {}
    }
}

/**
 * Receives the watchdog alarm, restarts the service if tracking is meant to be on, and re-arms
 * itself. Re-arming here rather than using a repeating alarm is deliberate: setAndAllowWhileIdle
 * is one-shot by design, and chaining keeps the whole cycle inside the Doze allowance.
 */
class WatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (!TrackingConfig.isEnabled(context)) {
                // Signed out or tracking disabled — stop burning alarms.
                ServiceWatchdog.cancel(context)
                return
            }
            // No credentials means the service could only spin with nothing to upload.
            val base = TrackingConfig.apiBaseUrl(context)
            val token = TrackingConfig.token(context)
            if (base.isNullOrBlank() || token.isNullOrBlank()) return

            TrackingService.start(context)
        } catch (_: Exception) {
            // Never let the watchdog be the thing that crashes the app.
        } finally {
            try { ServiceWatchdog.schedule(context) } catch (_: Exception) {}
        }
    }
}
