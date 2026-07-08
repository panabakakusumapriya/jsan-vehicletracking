import * as Location from 'expo-location';
import { PermissionsAndroid, Platform } from 'react-native';

export type PermissionResult = { ok: boolean; message?: string };

/**
 * Pre-flight gate the app must pass before tracking can run. Requests, in order:
 *  1) foreground location  2) background ("Allow all the time")
 *  3) activity recognition (Android 10+)  4) notifications (Android 13+)
 */
export async function ensurePermissions(): Promise<PermissionResult> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    return { ok: false, message: 'Location permission is required to track trips.' };
  }

  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    return {
      ok: false,
      message: 'Please set location access to "Allow all the time" so trips are tracked in the background.',
    };
  }

  if (Platform.OS === 'android') {
    const version = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
    if (version >= 29) {
      await PermissionsAndroid.request('android.permission.ACTIVITY_RECOGNITION' as any);
    }
    if (version >= 33) {
      await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
    }
  }

  return { ok: true };
}

export async function checkLocationEnabled(): Promise<boolean> {
  return Location.hasServicesEnabledAsync();
}
