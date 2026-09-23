package expo.modules.vtstracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Receives Activity-Recognition IN_VEHICLE transitions (via AutoStart's PendingIntent) and drives
 * auto mode. Fires even when the app is swiped from recents / killed — the OS restarts the app
 * process to deliver here.
 *   ENTER IN_VEHICLE → start a trip (TrackingService creates the session over HTTP, then records)
 *   EXIT  IN_VEHICLE → begin the auto-stop countdown for an auto-started trip
 */
class AutoStartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val prefs = context.getSharedPreferences(TrackingService.PREFS, Context.MODE_PRIVATE)
    if (!prefs.getBoolean("autoEnabled", false)) return

    for (event in result.transitionEvents) {
      if (event.activityType != DetectedActivity.IN_VEHICLE) continue
      when (event.transitionType) {
        ActivityTransition.ACTIVITY_TRANSITION_ENTER -> {
          // Started driving. Only auto-start if nothing is already recording (don't stomp a manual trip).
          if (!TrackingService.isRunning) {
            val svc = Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_AUTO_START)
            try { ContextCompat.startForegroundService(context, svc) } catch (_: Throwable) {}
          }
        }
        ActivityTransition.ACTIVITY_TRANSITION_EXIT -> {
          // Stopped driving. Only an AUTO-started trip auto-ends; a manual trip is never auto-ended.
          if (TrackingService.isRunning && prefs.getBoolean("autoStarted", false)) {
            val svc = Intent(context, TrackingService::class.java).setAction(TrackingService.ACTION_AUTO_EXIT)
            try { ContextCompat.startForegroundService(context, svc) } catch (_: Throwable) {}
          }
        }
      }
    }
  }
}
