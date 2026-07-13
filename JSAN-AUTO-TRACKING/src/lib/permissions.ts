import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';

export type PermissionResult = { ok: boolean; message?: string };

export type PermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable';

export type PermissionHealth = {
  fineLocation: PermissionStatus;
  backgroundLocation: PermissionStatus;
  activityRecognition: PermissionStatus;   // Android 10+ only
  notifications: PermissionStatus;          // Android 13+ only
};

function expoStatusToOurs(s: string): PermissionStatus {
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  return 'blocked';
}

function androidToOurs(s: typeof PermissionsAndroid.RESULTS[keyof typeof PermissionsAndroid.RESULTS]): PermissionStatus {
  if (s === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  if (s === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
  return 'denied';
}

/** Read current permission state without requesting anything. */
export async function getPermissionHealth(): Promise<PermissionHealth> {
  if (Platform.OS !== 'android') {
    // iOS / web — not critical for this app
    return {
      fineLocation: 'unavailable',
      backgroundLocation: 'unavailable',
      activityRecognition: 'unavailable',
      notifications: 'unavailable',
    };
  }

  const version = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();

  let activityRecognition: PermissionStatus = 'unavailable';
  if (version >= 29) {
    const granted = await PermissionsAndroid.check('android.permission.ACTIVITY_RECOGNITION' as any);
    activityRecognition = granted ? 'granted' : 'denied';
  }

  let notifications: PermissionStatus = 'unavailable';
  if (version >= 33) {
    const granted = await PermissionsAndroid.check('android.permission.POST_NOTIFICATIONS' as any);
    notifications = granted ? 'granted' : 'denied';
  }

  return {
    fineLocation: expoStatusToOurs(fg.status),
    backgroundLocation: expoStatusToOurs(bg.status),
    activityRecognition,
    notifications,
  };
}

/** Request all missing permissions in the correct order. Returns updated health. */
export async function requestAllPermissions(): Promise<PermissionHealth> {
  if (Platform.OS !== 'android') return getPermissionHealth();

  const version = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);

  // Must request foreground first, then background
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status === 'granted') {
    await Location.requestBackgroundPermissionsAsync();
  }

  if (version >= 29) {
    await PermissionsAndroid.request('android.permission.ACTIVITY_RECOGNITION' as any);
  }
  if (version >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
  }

  return getPermissionHealth();
}

/** Legacy helper used by home.tsx — calls requestAllPermissions and maps to simple ok/message. */
export async function ensurePermissions(): Promise<PermissionResult> {
  const health = await requestAllPermissions();

  if (health.fineLocation !== 'granted') {
    return { ok: false, message: 'Location permission is required to track trips.' };
  }
  if (health.backgroundLocation !== 'granted') {
    return {
      ok: false,
      message: 'Please set location access to "Allow all the time" so trips are tracked in the background.',
    };
  }

  return { ok: true };
}

export async function checkLocationEnabled(): Promise<boolean> {
  return Location.hasServicesEnabledAsync();
}

/** True when the two critical permissions for tracking are granted. */
export function isCriticalHealthOk(health: PermissionHealth): boolean {
  return health.fineLocation === 'granted' && health.backgroundLocation === 'granted';
}
