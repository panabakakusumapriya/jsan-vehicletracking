package expo.modules.vtstracker

/**
 * In-process bridge from the native TrackingService to the JS module, used only to push
 * LIVE fixes to the UI (map marker, stats) while the app is in the foreground. When the app
 * is minimized/killed the listener is null and these events simply drop — that's fine,
 * because recording + upload happen entirely in native code and never depend on this.
 */
object LocationBus {
  @Volatile
  var listener: ((Map<String, Any?>) -> Unit)? = null

  // Is the app's UI in the foreground? The service ONLY pushes live fixes to JS when this is
  // true. While the app is backgrounded the OS can freeze the JS thread, so native→JS events
  // would pile up unboundedly and then flood the JS thread on resume — the app freezes / shows
  // "Not responding". Gating on foreground keeps recording+upload running natively (those never
  // touch this bus) while making the UI bridge silent in the background. Default true: the
  // module is only created when JS is running, which is a foreground moment.
  @Volatile
  var foreground: Boolean = true
}
