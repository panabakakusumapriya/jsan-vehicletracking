import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * JS facade for the native (Android/Kotlin) VehicleTracker module.
 * The engine lives entirely in the foreground service, so JS only:
 *   - hands it config (backend URL + token + driverId)
 *   - starts/stops it
 *   - listens for status while the app is open
 * On non-Android platforms every call is a safe no-op.
 */

export type LocationEvent = {
  lat: number;
  lon: number;
  speedKmh: number;
  tripId: string;
  tripStatus: 'active' | 'ended' | 'timed_out';
  recordedAt: string;
};

export type TripEvent = { tripId: string; recordedAt: string };
export type StateEvent = { state: 'idle' | 'tracking' | 'idle_timeout' };
export type UploadErrorEvent = { reason: 'not_configured' | 'auth_failure' | string; message: string; code?: number };

export type TrackerStatus = {
  enabled: boolean;
  queued: number;
  currentTripId: string | null;
  driverId: string | null;
  apiBaseUrl: string | null;
};

export type DaylightInfo = {
  timezoneId: string;
  daylightOnly: boolean;
  lat: number | null;
  lon: number | null;
  sunrise?: string;
  sunset?: string;
  isDaylight?: boolean;
};

const isAndroid = Platform.OS === 'android';

/**
 * OPTIONAL on purpose.
 *
 * `requireNativeModule` THROWS when the module is not compiled into the running binary — which is
 * the case in Expo Go, and in any dev client built before this module existed. Because this file is
 * imported by src/lib/auth.tsx, which is imported by app/_layout.tsx, that throw happened during
 * module evaluation and took the entire app down before a single screen rendered:
 *
 *     requireNativeModule -> modules/vehicle-tracker/index.ts -> src/lib/auth.tsx -> app/_layout.tsx
 *     ...followed by "Couldn't find any screens for the navigator", which is only the fallout.
 *
 * `requireOptionalNativeModule` returns null instead. Every function below already guards on
 * `native`, and `isSupported` already tells the UI, so a missing module now degrades to "tracking
 * unavailable" rather than a white screen — which means the JS can be developed in Expo Go.
 */
const native = isAndroid ? (requireOptionalNativeModule('VehicleTracker') as any) : null;

if (isAndroid && !native && __DEV__) {
  // Loud, because silently running without a tracking engine is not something to discover later.
  console.warn(
    '[VehicleTracker] Native module not found — GPS tracking is DISABLED. ' +
    'This build is Expo Go or a dev client without the module. ' +
    'Run `npx expo run:android` or build the `development` EAS profile to enable it.'
  );
}

export const isSupported = isAndroid && native != null;

/**
 * Why tracking is unavailable, or null when it is fine. Two very different situations that used to
 * share one message: the wrong platform, versus the right platform running a binary that does not
 * contain the module. Telling a driver on Android that "tracking runs on Android only" sends them
 * looking in exactly the wrong place.
 */
export const unavailableReason: string | null = isSupported
  ? null
  : !isAndroid
    ? 'Background tracking runs on Android only.'
    : 'This build does not include the tracking module, so GPS tracking is off. Install a development build to enable it.';

export async function configure(apiBaseUrl: string, token: string, driverId: string): Promise<void> {
  if (native) await native.configure(apiBaseUrl, token, driverId);
}

export async function start(): Promise<void> {
  if (native) await native.start();
}

export async function stop(): Promise<void> {
  if (native) await native.stop();
}

export async function flushNow(): Promise<void> {
  if (native) await native.flushNow();
}

export async function getStatus(): Promise<TrackerStatus> {
  if (native) return native.getStatus();
  return { enabled: false, queued: 0, currentTripId: null, driverId: null, apiBaseUrl: null };
}

export async function getDaylightInfo(): Promise<DaylightInfo> {
  if (native) return native.getDaylightInfo();
  return { timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone, daylightOnly: true, lat: null, lon: null };
}

export async function setDaylightOnly(enabled: boolean): Promise<void> {
  if (native) await native.setDaylightOnly(enabled);
}

export async function setTimezone(timezoneId: string): Promise<void> {
  if (native) await native.setTimezone(timezoneId);
}

export function addLocationListener(cb: (e: LocationEvent) => void): EventSubscription | null {
  return native ? native.addListener('onLocation', cb) : null;
}
export function addTripStartListener(cb: (e: TripEvent) => void): EventSubscription | null {
  return native ? native.addListener('onTripStart', cb) : null;
}
export function addTripEndListener(cb: (e: TripEvent) => void): EventSubscription | null {
  return native ? native.addListener('onTripEnd', cb) : null;
}
export function addStateListener(cb: (e: StateEvent) => void): EventSubscription | null {
  return native ? native.addListener('onStateChange', cb) : null;
}
export function addUploadErrorListener(cb: (e: UploadErrorEvent) => void): EventSubscription | null {
  return native ? native.addListener('onUploadError', cb) : null;
}

export default {
  isSupported,
  configure,
  start,
  stop,
  flushNow,
  getStatus,
  getDaylightInfo,
  setDaylightOnly,
  setTimezone,
  addLocationListener,
  addTripStartListener,
  addTripEndListener,
  addStateListener,
  addUploadErrorListener,
};
