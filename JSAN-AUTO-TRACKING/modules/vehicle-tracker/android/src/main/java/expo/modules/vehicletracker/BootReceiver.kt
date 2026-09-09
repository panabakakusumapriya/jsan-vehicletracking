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

        // NO daylight gate here.
        //
        // Daylight-only tracking was retired everywhere else (it lost whole night shifts, and the
        // resulting silence made the server watchdog close live trips), but this one path still
        // enforced it — and it reads the PERSISTED preference, which is still `true` on every
        // handset that ran a build from before the policy changed. The effect was that those
        // devices silently refused to resume tracking after any night-time reboot, forever, with
        // nothing in the UI to explain it.
        Log.i("JSANBoot", "Restarting TrackingService after $action")
        TrackingService.start(context)
        // Arm the restart alarm too: a reboot is exactly when an OEM power manager is most
        // likely to drop the service again a few minutes later.
        ServiceWatchdog.schedule(context)
    }
}
