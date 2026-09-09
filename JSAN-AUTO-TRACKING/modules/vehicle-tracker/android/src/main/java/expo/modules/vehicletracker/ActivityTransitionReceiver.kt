package expo.modules.vehicletracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Wakes the tracking service when the device starts moving, and updates the
 * STILL flag used by the service to suppress GPS drift.
 *
 * STILL detection is backed by Google's on-device ML model (accelerometer + gyro)
 * so it is far more reliable than raw sensor math — the same signal MyCarTracks uses.
 *
 * ENTER STILL  → mark isStill=true in prefs  (service zeroes effective speed → stops trip timer)
 * EXIT  STILL  → mark isStill=false
 * ENTER moving → isStill=false + wake service if it was stopped by the idle timeout
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!TrackingConfig.isEnabled(context)) return
        if (!ActivityTransitionResult.hasResult(intent)) return

        val result = ActivityTransitionResult.extractResult(intent) ?: return
        for (event in result.transitionEvents) {
            when {
                // Device became stationary — tell the service via shared prefs
                event.activityType == DetectedActivity.STILL &&
                event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER -> {
                    TrackingConfig.setStill(context, true)
                }

                // Device stopped being still (any movement type) or we got an explicit EXIT STILL
                event.activityType == DetectedActivity.STILL &&
                event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_EXIT -> {
                    TrackingConfig.setStill(context, false)
                }

                // Movement transitions: clear STILL and remember the classification. Only a
                // vehicle-like transition wakes the full foreground tracker. Waking GPS, two
                // raw sensors and the uploader for ordinary walking was a major heat/battery
                // cost and could never legitimately open the low-speed vehicle gate anyway.
                event.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER &&
                event.activityType in listOf(
                    DetectedActivity.IN_VEHICLE,
                    DetectedActivity.ON_BICYCLE,
                    DetectedActivity.ON_FOOT,
                    DetectedActivity.WALKING,
                    DetectedActivity.RUNNING,
                ) -> {
                    TrackingConfig.setStill(context, false)
                    val vehicleLike = event.activityType == DetectedActivity.IN_VEHICLE ||
                        event.activityType == DetectedActivity.ON_BICYCLE
                    TrackingConfig.setLastActivity(
                        context,
                        if (vehicleLike) TrackingConfig.ACTIVITY_VEHICLE else TrackingConfig.ACTIVITY_FOOT
                    )
                    if (vehicleLike) {
                        TrackingService.start(context, activityWake = true)
                        return
                    }
                }
            }
        }
    }
}
