package expo.modules.vtstracker

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity

/**
 * "Auto mode" — uses Google Activity Recognition to detect when the user starts/stops DRIVING and
 * starts/ends a trip automatically, even when the app has been swiped from recents or killed
 * (the OS delivers transitions to AutoStartReceiver's PendingIntent and restarts the app if needed).
 *
 * Config (base API url + auth token) is persisted so the receiver can create a session over HTTP
 * with no JS running. Re-armed on boot / app-update (transition registrations don't survive those).
 */
object AutoStart {
  private const val REQ = 8500
  const val ACTION = "expo.modules.vtstracker.ACTIVITY_TRANSITION"

  private fun pendingIntent(ctx: Context): PendingIntent {
    val i = Intent(ctx, AutoStartReceiver::class.java).setAction(ACTION)
    // AR fills the result into the intent → it must be MUTABLE on Android 12+.
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
    return PendingIntent.getBroadcast(ctx, REQ, i, flags)
  }

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(TrackingService.PREFS, Context.MODE_PRIVATE)

  /** Persist config + register IN_VEHICLE enter/exit transition updates. Idempotent. */
  @SuppressLint("MissingPermission")
  fun enable(ctx: Context, baseUrl: String, token: String) {
    prefs(ctx).edit()
      .putBoolean("autoEnabled", true)
      .putString("autoBaseUrl", baseUrl.trimEnd('/'))
      .putString("autoToken", token)
      .apply()
    val transitions = listOf(
      ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER).build(),
      ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE)
        .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT).build(),
    )
    try {
      ActivityRecognition.getClient(ctx)
        .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pendingIntent(ctx))
    } catch (_: Throwable) {
      // ACTIVITY_RECOGNITION permission missing or Play Services unavailable → auto mode just
      // won't fire; manual tracking is unaffected.
    }
  }

  fun disable(ctx: Context) {
    prefs(ctx).edit().putBoolean("autoEnabled", false).apply()
    try { ActivityRecognition.getClient(ctx).removeActivityTransitionUpdates(pendingIntent(ctx)) } catch (_: Throwable) {}
  }

  /** Re-register after boot / app-update if auto mode is on (registrations don't survive those). */
  fun rearmIfEnabled(ctx: Context) {
    val p = prefs(ctx)
    if (!p.getBoolean("autoEnabled", false)) return
    enable(ctx, p.getString("autoBaseUrl", "") ?: "", p.getString("autoToken", "") ?: "")
  }
}
