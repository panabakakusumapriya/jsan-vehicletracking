import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as VehicleTracker from '@/modules/vehicle-tracker';
import { useAuth } from '@/src/lib/auth';
import { API_BASE_URL } from '@/src/lib/config';
import { getPermissionHealth } from '@/src/lib/permissions';

/**
 * Starting the engine without a location grant is not merely useless, it is fatal on Android 14+:
 * entering the foreground with a location service type throws SecurityException when the grant is
 * missing, which killed the service on the first launch after login on any handset shipping
 * Android 14 (Realme 12 Pro+, and every other 2024 device). The native side now refuses that start
 * cleanly, and this stops it being asked for in the first place.
 *
 * Requesting the permission stays with the Home screen, which owns the explanatory UI — asking
 * from here as well would put two system dialogs in flight at once, and Android answers the
 * second with an automatic denial.
 */
async function locationGranted(): Promise<boolean> {
  try {
    return (await getPermissionHealth()).fineLocation === 'granted';
  } catch {
    return false;
  }
}

/**
 * Starts the tracking engine for every signed-in DRIVER, no matter which screens a project
 * enables.
 *
 * It used to live only in home.tsx — and the day a project disabled the Dashboard tab,
 * drivers were routed straight to /map, home never mounted, and tracking silently never
 * started. That was the "tracking worked until we added disabled modules" regression: the
 * engine's lifecycle belongs to the SESSION, not to a tab.
 *
 * Also owns the token-follow rule at the right altitude (the session), so a re-login keeps
 * the native uploader's token fresh even if no screen that knows about tracking ever mounts.
 * home.tsx keeps its richer startup (permission UX, timezone from server, status card) —
 * configure/start are idempotent, so both running is harmless.
 */
export function TrackingBootstrap() {
  const { user, token } = useAuth();
  const configuredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user || user.role !== 'user' || !token || !user._id) return;
    if (!VehicleTracker.isSupported || !API_BASE_URL) return;
    const key = `${token}|${user._id}`;
    if (configuredRef.current === key) return;
    configuredRef.current = key;
    (async () => {
      try {
        const tz = user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) await VehicleTracker.setTimezone(tz);
        await VehicleTracker.configure(API_BASE_URL, token, user._id);
        // configure() is always safe and must persist regardless; only the START waits for the
        // grant. The AppState listener below picks it up the moment the driver comes back from
        // the permission prompt.
        if (await locationGranted()) await VehicleTracker.start();
      } catch {
        /* the permission gate + home's startup surface failures; this must never crash the tree */
      }
    })();
  }, [user, token]);

  // A napping service (10-minute idle stop) must revive the moment the driver RETURNS to
  // the app — not only when Activity Recognition notices a drive. start() is idempotent and
  // a foreground start is always legal, so this is free insurance: open app = tracker up.
  useEffect(() => {
    if (!user || user.role !== 'user' || !token || !VehicleTracker.isSupported) return;
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      // Also the recovery path after the driver grants location in Settings: returning to the
      // app is exactly when a previously refused start becomes possible.
      void (async () => {
        if (await locationGranted()) await VehicleTracker.start().catch(() => {});
      })();
    });
    return () => sub.remove();
  }, [user, token]);

  return null;
}
