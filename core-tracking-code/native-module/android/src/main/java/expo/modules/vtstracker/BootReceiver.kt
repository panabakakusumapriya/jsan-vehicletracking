package expo.modules.vtstracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Restart recording after a device reboot if a trip was active when the phone went down —
 * one of the behaviors that makes this resilient like SW Maps.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val a = intent.action
    // Restart after a reboot (boot/locked-boot/OEM quickboot) OR after the app is updated
    // (MY_PACKAGE_REPLACED) — both kill our service, and an active trip must resume.
    if (a == Intent.ACTION_BOOT_COMPLETED || a == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
        a == Intent.ACTION_MY_PACKAGE_REPLACED || a == "android.intent.action.QUICKBOOT_POWERON") {
      // Re-arm auto mode (Activity-Recognition transition updates don't survive reboot/update).
      try { AutoStart.rearmIfEnabled(ctx) } catch (_: Throwable) {}

      val active = ctx.getSharedPreferences(TrackingService.PREFS, Context.MODE_PRIVATE).getBoolean("active", false)
      if (active) {
        try {
          val i = Intent(ctx, TrackingService::class.java).apply { action = TrackingService.ACTION_START }
          ContextCompat.startForegroundService(ctx, i)
        } catch (_: Throwable) {
          // Some OEMs/Android 14 may block starting a location FGS straight from boot.
          // Not fatal: the trip resumes when the driver next opens the app.
        }
      }
    }
  }
}
