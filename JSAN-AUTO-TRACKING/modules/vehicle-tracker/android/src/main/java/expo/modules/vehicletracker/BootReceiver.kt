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

        Log.i("JSANBoot", "Restarting TrackingService after $action")
        TrackingService.start(context)
    }
}
