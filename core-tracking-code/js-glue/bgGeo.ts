// ---------------------------------------------------------------------------
// Background-geolocation engine — abstraction layer.
//
// WHY: on aggressive OEMs (Xiaomi/POCO, Oppo, Vivo) Android freezes the JS engine the
// moment the app is minimized, so the old expo-location capture only persisted points when
// the app was reopened (and lost them if the OS killed the frozen process). The engine below
// records in NATIVE code (a foreground service + on-device SQLite), independent of the JS
// runtime, and auto-uploads to the backend. A point is deleted on-device ONLY after the
// server returns 2xx → lossless for payroll.
//
// CURRENT ENGINE: our own native module `modules/my-module` (free, no license).
// To switch to the Transistor engine later, this is the ONLY file that changes — re-point
// the calls below at react-native-background-geolocation (see git history for that version)
// and add the license. LocationContext, the UI, and the backend stay identical.
//
// Backend contract: POST `${API_URL}/locations/transistor`
//   body = { location: [ {coords, timestamp}, ... ], sessionId }
//   2xx → delete locally · 409 → retry soon · 5xx → keep + retry later
// ---------------------------------------------------------------------------
import AsyncStorage from '@react-native-async-storage/async-storage';
import VtsTracker from '../modules/my-module';
import { API_URL } from '../constants/Config';

const TRACKER_URL = `${API_URL}/locations/transistor`;

export type BgLocation = {
  coords: { latitude: number; longitude: number; accuracy?: number; speed?: number; heading?: number; altitude?: number };
  timestamp: number;
};

let sub: { remove: () => void } | null = null;
let onLocationCb: ((loc: BgLocation) => void) | null = null;

/** Register a callback to mirror native fixes into the React UI (map marker, stats). */
export function setOnLocation(cb: ((loc: BgLocation) => void) | null) {
  onLocationCb = cb;
  if (!sub) {
    sub = VtsTracker.addListener('onLocation', (loc: any) => {
      try { onLocationCb && onLocationCb(loc); } catch (_) {}
    });
  }
}

/** Begin recording for a trip. Idempotent — the native service updates config if already running. */
export async function start(sessionId: string, token: string): Promise<void> {
  // Ask to be exempt from battery optimization the moment tracking matters — without this,
  // Doze/OEM battery savers freeze the foreground service (the #1 background-loss cause).
  try { await VtsTracker.requestIgnoreBatteryOptimizations(); } catch (_) {}
  // ONCE per install, open the manufacturer's Autostart screen (Xiaomi/Oppo/Vivo/Huawei require
  // it for background tracking to survive a swipe-away). Guarded so it isn't shown every trip.
  try {
    if (!(await AsyncStorage.getItem('autostartPrompted_v1'))) {
      await AsyncStorage.setItem('autostartPrompted_v1', '1');
      await VtsTracker.openAutostartSettings();
    }
  } catch (_) {}
  await VtsTracker.start(
    TRACKER_URL,
    token,
    sessionId,
    'JSAN VTS — Recording trip',
    'Your route is being recorded for payroll.'
  );
}

/** Flush queued points, then stop recording. */
export async function stop(): Promise<void> {
  try { await VtsTracker.stop(); } catch (e) { console.warn('[bgGeo] stop error', (e as any)?.message); }
}

/** Current engine state ({ enabled }) or null if unavailable. */
export async function getState(): Promise<{ enabled: boolean } | null> {
  try { return await VtsTracker.getState(); } catch { return null; }
}

/** Manually trigger an upload of the on-device queue. */
export async function syncNow(): Promise<void> {
  try { await VtsTracker.sync(); } catch (_) {}
}

/** Count of points still queued on-device (not yet acked by the server). */
export async function pendingCount(): Promise<number> {
  try { return await VtsTracker.getPendingCount(); } catch { return 0; }
}

/** Is the app exempt from battery optimization (Doze)? When false, OEMs can kill tracking. */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  try { return await VtsTracker.isIgnoringBatteryOptimizations(); } catch { return true; }
}

/** Prompt the user to whitelist the app from battery optimization (no-op if already exempt). */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  try { await VtsTracker.requestIgnoreBatteryOptimizations(); } catch (_) {}
}

export type ReliabilityStatus = {
  batteryOptimized: boolean;        // true = a problem (not exempt)
  powerSaveMode: boolean;
  backgroundDataRestricted: boolean;
  exactAlarmBlocked: boolean;
  backgroundLocationMissing: boolean;
  manufacturer: string;
};
/** Detect every common background-kill obstacle for the reliability checklist. */
export async function getReliabilityStatus(): Promise<ReliabilityStatus | null> {
  try { return await VtsTracker.getReliabilityStatus(); } catch { return null; }
}
export async function openAutostartSettings(): Promise<void> { try { await VtsTracker.openAutostartSettings(); } catch (_) {} }
export async function openAppDetailsSettings(): Promise<void> { try { await VtsTracker.openAppDetailsSettings(); } catch (_) {} }
export async function openDataUsageSettings(): Promise<void> { try { await VtsTracker.openDataUsageSettings(); } catch (_) {} }
export async function openExactAlarmSettings(): Promise<void> { try { await VtsTracker.openExactAlarmSettings(); } catch (_) {} }

/** AUTO MODE — arm native Activity-Recognition driving detection. While armed, a trip starts
 *  automatically when the user begins driving and ends after they stop, even if the app is swiped
 *  from recents / killed. `baseUrl` is the API root (e.g. `${API_URL}`), `token` the auth token. */
export async function enableAutoStart(baseUrl: string, token: string): Promise<void> {
  try { await VtsTracker.enableAutoStart(baseUrl, token); } catch (_) {}
}
/** Disarm auto mode. */
export async function disableAutoStart(): Promise<void> {
  try { await VtsTracker.disableAutoStart(); } catch (_) {}
}
