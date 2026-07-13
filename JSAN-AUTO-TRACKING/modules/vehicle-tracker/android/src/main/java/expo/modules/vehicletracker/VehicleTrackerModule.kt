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
            Thread { Uploader.flush(context.applicationContext) }.start()
        }

        AsyncFunction("getStatus") {
            mapOf(
                "enabled" to TrackingConfig.isEnabled(context),
                "queued" to LocationDatabase(context).count(),
                "currentTripId" to TrackingConfig.currentTripId(context),
                "driverId" to TrackingConfig.driverId(context),
                "apiBaseUrl" to TrackingConfig.apiBaseUrl(context)
            )
        }
    }
}
