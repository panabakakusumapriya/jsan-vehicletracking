package expo.modules.vehicletracker

/**
 * Bridge from the (always-running) native service to the JS layer, when it is alive.
 * The Expo module installs `sink` while mounted and clears it on destroy. When the app
 * is killed, `sink` is null and emits are simply dropped — the service keeps working.
 */
object TrackerEvents {
    @Volatile
    var sink: ((String, Map<String, Any?>) -> Unit)? = null

    fun emit(name: String, params: Map<String, Any?>) {
        sink?.invoke(name, params)
    }
}
