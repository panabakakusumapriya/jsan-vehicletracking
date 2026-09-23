package expo.modules.vtstracker

import android.Manifest
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS-facing API for the native tracking engine. It only starts/stops the foreground service
 * and reports state — it deliberately holds NO recording logic, so even when JS is frozen or
 * dead the service keeps recording and uploading on its own.
 */
class VtsTrackerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VtsTracker")

    Events("onLocation")

    OnCreate {
      // Forward native live fixes to JS while the app is alive (for the live map/stats).
      LocationBus.listener = { data -> sendEvent("onLocation", data) }
      LocationBus.foreground = true
    }

    OnDestroy {
      LocationBus.listener = null
    }

    // Foreground/background gating for the live-fix bridge. When the app is backgrounded the OS
    // may freeze the JS thread; if the service kept emitting, native→JS events would queue up and
    // then flood the JS thread on resume → the app shows "Not responding". We mark foreground
    // state here so the service goes UI-silent in the background. Recording + upload run natively
    // and never depend on this, so background tracking is unaffected.
    OnActivityEntersForeground {
      LocationBus.foreground = true
    }
    OnActivityEntersBackground {
      LocationBus.foreground = false
    }

    AsyncFunction("start") { url: String, token: String, sessionId: String, title: String, text: String ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("No React context")
      val i = Intent(ctx, TrackingService::class.java).apply {
        action = TrackingService.ACTION_START
        putExtra("url", url)
        putExtra("token", token)
        putExtra("session", sessionId)
        putExtra("title", title)
        putExtra("text", text)
      }
      ContextCompat.startForegroundService(ctx, i)
    }

    AsyncFunction("stop") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      try {
        ctx.startService(Intent(ctx, TrackingService::class.java).apply { action = TrackingService.ACTION_STOP })
      } catch (_: Throwable) {}
      true
    }

    AsyncFunction("sync") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      try {
        ctx.startService(Intent(ctx, TrackingService::class.java).apply { action = TrackingService.ACTION_SYNC })
      } catch (_: Throwable) {}
      true
    }

    // AUTO MODE — arm/disarm Activity-Recognition driving detection. While armed, a trip starts
    // automatically when the user begins driving and ends after they stop, even if the app is
    // swiped from recents / killed. baseUrl = API root (e.g. https://…/api); token = auth token.
    AsyncFunction("enableAutoStart") { baseUrl: String, token: String ->
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      AutoStart.enable(ctx, baseUrl, token)
      true
    }

    AsyncFunction("disableAutoStart") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      AutoStart.disable(ctx)
      true
    }

    AsyncFunction("getState") {
      mapOf("enabled" to TrackingService.isRunning)
    }

    AsyncFunction("getPendingCount") {
      val ctx = appContext.reactContext ?: return@AsyncFunction 0
      LocationDb(ctx).pending()
    }

    // Is the app exempt from battery optimization (Doze)? When false, aggressive OEMs can
    // freeze/kill the foreground service — the #1 cause of background tracking loss.
    AsyncFunction("isIgnoringBatteryOptimizations") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    // Open the manufacturer's AUTOSTART / background-start screen so the user can allow the app
    // to start in the background. On Xiaomi/Oppo/Vivo/Huawei this is REQUIRED for tracking to
    // survive a swipe-away/reboot — START_STICKY + the watchdog can't override it. Tries each
    // OEM component defensively (component names change across OS versions); returns true on the
    // first that opens. Caller should show this once on first run.
    AsyncFunction("openAutostartSettings") {
      val candidates = listOf(
        "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
        "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
        "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
        "com.huawei.systemmanager" to "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
        "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
        "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
        "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
        "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
        "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
        "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
        "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
        "com.oneplus.security" to "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity",
        "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity"
      )
      for ((pkg, cls) in candidates) {
        // launch from the Activity; if the OEM component is absent it returns false → try next.
        if (launchSettings(Intent().apply { setClassName(pkg, cls) })) return@AsyncFunction true
      }
      return@AsyncFunction false
    }

    // Reliability checklist: detect every common background-kill obstacle so the UI can show a
    // ✅/⚠️ status and a one-tap fix (like the mature trackers do). true = a PROBLEM to fix.
    AsyncFunction("getReliabilityStatus") {
      val ctx = appContext.reactContext ?: return@AsyncFunction emptyMap<String, Any>()
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      mapOf(
        "batteryOptimized" to !pm.isIgnoringBatteryOptimizations(ctx.packageName),
        "powerSaveMode" to pm.isPowerSaveMode,
        "backgroundDataRestricted" to (cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED),
        "exactAlarmBlocked" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()),
        "backgroundLocationMissing" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
          ctx.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED),
        "manufacturer" to Build.MANUFACTURER
      )
    }

    // Open the app's system details page (fix for background-location + power-save on most OEMs).
    AsyncFunction("openAppDetailsSettings") {
      val pkg = appContext.reactContext?.packageName ?: return@AsyncFunction false
      launchSettings(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply { data = Uri.parse("package:$pkg") })
    }

    // Open the "unrestricted background data" screen for this app.
    AsyncFunction("openDataUsageSettings") {
      val pkg = appContext.reactContext?.packageName ?: return@AsyncFunction false
      launchSettings(Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS).apply { data = Uri.parse("package:$pkg") })
    }

    // Open the "allow exact alarms" screen (Android 12+) so the watchdog can fire precisely.
    AsyncFunction("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@AsyncFunction false
      val pkg = appContext.reactContext?.packageName ?: return@AsyncFunction false
      launchSettings(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply { data = Uri.parse("package:$pkg") })
    }

    // Prompt the user to whitelist the app from battery optimization (no-op if already exempt).
    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val ctx = appContext.reactContext ?: return@AsyncFunction false
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) return@AsyncFunction true
      launchSettings(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:" + ctx.packageName) })
    }
  }

  // Launch a settings/intent from the CURRENT ACTIVITY when available. Aggressive OEMs (MIUI/POCO,
  // ColorOS, etc.) silently BLOCK activity launches from a background/app context, which made our
  // "Fix"/"Open" buttons do nothing. From an Activity they open normally (this is how MyCarTracks
  // does it). Falls back to the app context (+NEW_TASK) only if no Activity is available.
  private fun launchSettings(intent: Intent): Boolean {
    return try {
      val activity = appContext.currentActivity
      if (activity != null) {
        activity.startActivity(intent)
      } else {
        val ctx = appContext.reactContext ?: return false
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      true
    } catch (_: Throwable) { false }
  }
}
