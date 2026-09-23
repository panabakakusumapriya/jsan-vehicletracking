package expo.modules.vehicletracker

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VehicleTrackerModule : Module() {

    private val context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    override fun definition() = ModuleDefinition {
        Name("VehicleTracker")

        Events("onLocation", "onTripStart", "onTripEnd", "onStateChange", "onUploadError")

        OnCreate {
            // Wire the always-on native service to JS events while the app is alive.
            TrackerEvents.sink = { name, params -> sendEvent(name, params) }
        }

        OnDestroy {
            TrackerEvents.sink = null
        }

        // Persist backend URL + auth token + driverId so the service can upload
        // autonomously, even after the app is killed or the device reboots.
        AsyncFunction("configure") { apiBaseUrl: String, token: String, driverId: String ->
            TrackingConfig.save(context, apiBaseUrl, token, driverId)
        }

        AsyncFunction("start") {
            TrackingConfig.setEnabled(context, true)
            TrackingService.start(context)
        }

        AsyncFunction("stop") {
            TrackingConfig.setEnabled(context, false)
            TrackingService.stop(context)
        }

        AsyncFunction("flushNow") {
            Uploader.schedule(context.applicationContext)
        }

        AsyncFunction("getStatus") {
            // The stop timeout the ticker would ACTUALLY use right now, resolved exactly the way
            // it resolves it — the stored project override when there is one, else the built-in
            // default. Reported so the driver's own screen can show the number, which is the only
            // way anyone can confirm an admin's change reached this handset without waiting to
            // park a vehicle and time it with a watch.
            val override = TrackingConfig.tripEndNoMoveMs(context)
            val effective = if (override > 0L) override else TrackingService.TRIP_END_NO_MOVE_MS
            mapOf(
                "enabled" to TrackingConfig.isEnabled(context),
                "queued" to LocationDatabase(context).count(),
                "currentTripId" to TrackingConfig.currentTripId(context),
                "driverId" to TrackingConfig.driverId(context),
                "apiBaseUrl" to TrackingConfig.apiBaseUrl(context),
                "tripEndAfterMinutes" to (effective / 60_000L).toInt(),
                "tripEndIsProjectSetting" to (override > 0L)
            )
        }

        AsyncFunction("getDaylightInfo") {
            val tzId = TrackingConfig.timezoneId(context) ?: java.util.TimeZone.getDefault().id
            val lat = TrackingConfig.lastLat(context)
            val lon = TrackingConfig.lastLon(context)
            val daylightOnly = TrackingConfig.isDaylightOnly(context)

            val result = mutableMapOf<String, Any?>(
                "timezoneId" to tzId,
                "daylightOnly" to daylightOnly,
                "lat" to if (lat.isNaN()) null else lat,
                "lon" to if (lon.isNaN()) null else lon,
            )

            if (!lat.isNaN() && !lon.isNaN()) {
                val daylight = SunTimes.today(lat, lon, tzId)
                if (daylight != null) {
                    result["sunrise"] = daylight.sunriseFormatted()
                    result["sunset"] = daylight.sunsetFormatted()
                    result["isDaylight"] = daylight.isDaylight(System.currentTimeMillis())
                }
            }
            result
        }

        AsyncFunction("setDaylightOnly") { enabled: Boolean ->
            TrackingConfig.setDaylightOnly(context, enabled)
        }

        AsyncFunction("setTimezone") { timezoneId: String ->
            TrackingConfig.setTimezoneId(context, timezoneId)
        }

        /**
         * The driver's project-level stop timeout, in minutes; 0 or null clears the override and
         * returns the handset to TrackingService.TRIP_END_NO_MOVE_MS.
         *
         * The heartbeat response is the main delivery path — it reaches the service while it is
         * running in the background. This one exists for the moment the heartbeat cannot cover:
         * a freshly installed or freshly signed-in app, where /me has the answer before the
         * service has sent anything.
         */
        AsyncFunction("setTripEndAfterMinutes") { minutes: Int ->
            TrackingConfig.setTripEndAfterMinutes(context, minutes)
        }

        // ── Battery optimisation: the #1 silent background-tracking killer ───
        AsyncFunction("isIgnoringBatteryOptimizations") {
            val pm = context.getSystemService(android.content.Context.POWER_SERVICE)
                as? android.os.PowerManager
            pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        }

        AsyncFunction("requestIgnoreBatteryOptimizations") {
            val intent = android.content.Intent(
                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                android.net.Uri.parse("package:" + context.packageName)
            )
            val activity = appContext.currentActivity
            if (activity != null) {
                activity.startActivity(intent)
            } else {
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
        }
    }
}
