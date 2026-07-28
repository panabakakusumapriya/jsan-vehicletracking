package expo.modules.vehicletracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Restart tracking after a device reboot (install-once behaviour). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        val isBoot = action == Intent.ACTION_BOOT_COMPLETED ||
                     action == "android.intent.action.QUICKBOOT_POWERON" ||
                     action == Intent.ACTION_MY_PACKAGE_REPLACED

        if (!isBoot) return
        if (!TrackingConfig.isEnabled(context)) return

        // Validate config before starting — avoids the service running with a stale/empty token
        val base  = TrackingConfig.apiBaseUrl(context)
        val token = TrackingConfig.token(context)
        val driver = TrackingConfig.driverId(context)

        if (base.isNullOrBlank() || token.isNullOrBlank() || driver.isNullOrBlank()) {
            Log.w("JSANBoot", "Skipping auto-start: tracking config incomplete (requires app re-open)")
            return
        }

        // Skip boot-start if it's outside daylight hours
        if (TrackingConfig.isDaylightOnly(context)) {
            val tzId = TrackingConfig.timezoneId(context)
            val lat = TrackingConfig.lastLat(context)
            val lon = TrackingConfig.lastLon(context)
            if (tzId != null && !lat.isNaN() && !lon.isNaN()) {
                val daylight = SunTimes.today(lat, lon, tzId)
                if (daylight != null && !daylight.isDaylight(System.currentTimeMillis())) {
                    Log.i("JSANBoot", "Skipping auto-start: outside daylight hours (sunrise ${daylight.sunriseFormatted()})")
                    return
                }
            }
        }

        Log.i("JSANBoot", "Restarting TrackingService after $action")
        TrackingService.start(context)
    }
}
