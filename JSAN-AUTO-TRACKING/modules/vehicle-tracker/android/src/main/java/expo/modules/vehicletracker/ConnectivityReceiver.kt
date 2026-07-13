package expo.modules.vehicletracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Triggered when network connectivity is restored.
 * Immediately flushes the SQLite queue so offline-recorded points reach the server
 * as soon as the driver gets signal — same pattern as MyCarTracks ConnectivityReceiver.
 */
class ConnectivityReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (NetworkUtil.isOnline(context)) {
            Thread { Uploader.flush(context) }.start()
        }
    }
}
