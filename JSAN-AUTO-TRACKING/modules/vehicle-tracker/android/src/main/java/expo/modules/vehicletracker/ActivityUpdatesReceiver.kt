package expo.modules.vehicletracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Continuous activity sampling, as opposed to ActivityTransitionReceiver's edge triggers.
 *
 * The transition API only speaks when the classification CHANGES, and it drops the confidence on
 * the floor — so the service could only ever know "the last thing Google said, at some point in
 * the past". That is what forced FOOT_VETO_MS to be a blunt ten-minute veto: a stale ON_FOOT
 * from walking to the vehicle was indistinguishable from a live one.
 *
 * These updates arrive on a fixed interval with the full ranked list and its confidences, so
 * MotionClassifier can weigh a 40%-confidence guess differently from a 90% one, and can tell a
 * verdict from thirty seconds ago from one from ten minutes ago.
 *
 * Confidences are folded into two numbers — vehicle-ish and foot-ish — because that is the only
 * distinction the trip-start gate makes. ON_FOOT is the parent class of WALKING and RUNNING and
 * their confidences overlap, so the strongest of the three is taken rather than their sum.
 */
class ActivityUpdatesReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!TrackingConfig.isEnabled(context)) return
        if (!ActivityRecognitionResult.hasResult(intent)) return
        val result = ActivityRecognitionResult.extractResult(intent) ?: return

        var vehicle = 0
        var foot = 0
        for (activity in result.probableActivities) {
            when (activity.type) {
                DetectedActivity.IN_VEHICLE,
                DetectedActivity.ON_BICYCLE -> vehicle = maxOf(vehicle, activity.confidence)

                DetectedActivity.ON_FOOT,
                DetectedActivity.WALKING,
                DetectedActivity.RUNNING -> foot = maxOf(foot, activity.confidence)
            }
        }
        TrackingConfig.setActivityConfidence(context, vehicle, foot)
    }
}
