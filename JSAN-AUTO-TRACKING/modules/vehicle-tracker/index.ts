import { Platform } from 'react-native';
import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

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

const isAndroid = Platform.OS === 'android';

// Only require the native module on Android; keeps iOS/web from throwing.
const native = isAndroid ? (requireNativeModule('VehicleTracker') as any) : null;

export const isSupported = isAndroid && native != null;

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
  addLocationListener,
  addTripStartListener,
  addTripEndListener,
  addStateListener,
  addUploadErrorListener,
};
