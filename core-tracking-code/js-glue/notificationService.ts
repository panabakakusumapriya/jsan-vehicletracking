import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure how notifications behave when the app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

let permissionsRequested = false;

export async function ensureNotificationPermissions(): Promise<boolean> {
  if (permissionsRequested) return true;
  permissionsRequested = true;
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.status === 'granted') return true;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.status === 'granted';
  } catch (e) {
    console.warn('Notification permission error:', (e as any)?.message);
    return false;
  }
}

// Create Android channel (required on Android 8+)
export async function setupNotificationChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('vts-alerts', {
      name: 'VTS Tracking Alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('vts-reminders', {
      name: 'VTS Reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 200],
      sound: 'default',
    });
  } catch (e) {
    console.warn('Channel setup failed:', (e as any)?.message);
  }
}

export async function showLocalNotification(
  title: string,
  body: string,
  channel: 'vts-alerts' | 'vts-reminders' = 'vts-alerts'
) {
  try {
    await ensureNotificationPermissions();
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default' },
      trigger: Platform.OS === 'android' ? ({ channelId: channel } as any) : null,
    });
  } catch (e) {
    console.warn('Notification post failed:', (e as any)?.message);
  }
}

export async function schedulePeriodicLensCheck(intervalMinutes = 30) {
  try {
    await cancelPeriodicLensCheck(); // clear any existing
    const trigger: any = {
      seconds: intervalMinutes * 60,
      repeats: true,
      channelId: 'vts-reminders',
    };
    await Notifications.scheduleNotificationAsync({
      identifier: 'periodic-lens-check',
      content: {
        title: '📷 Lens Cleanliness Check',
        body: 'Please verify your camera lens is clean. Open the app to take a quick check photo.',
        sound: 'default',
      },
      trigger,
    });
  } catch (e) {
    console.warn('Schedule periodic lens check failed:', (e as any)?.message);
  }
}

export async function cancelPeriodicLensCheck() {
  try {
    await Notifications.cancelScheduledNotificationAsync('periodic-lens-check');
  } catch (_) {}
}

export async function cancelAllScheduled() {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch (_) {}
}

// ─── PENDING-SYNC reminder notifications ──────────────────────────────
// Shown when driver has unsynced location points after ending a session.
// Reminds them to open the app + connect to internet so data syncs.

export async function showPendingSyncNotification(count: number) {
  if (count <= 0) return;
  try {
    await ensureNotificationPermissions();
    await setupNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: 'pending-sync-reminder',
      content: {
        title: '⚠️ Pending Data — Please Open App',
        body: `You have ${count} location${count > 1 ? 's' : ''} from your last trip waiting to sync. Please open the app and connect to the internet so your records are saved.`,
        sound: 'default',
        priority: (Notifications as any).AndroidNotificationPriority?.HIGH,
      },
      trigger: Platform.OS === 'android' ? ({ channelId: 'vts-alerts' } as any) : null,
    });
  } catch (e) {
    console.warn('Pending-sync notification failed:', (e as any)?.message);
  }
}

export async function cancelPendingSyncNotification() {
  try { await Notifications.cancelScheduledNotificationAsync('pending-sync-reminder'); } catch (_) {}
}

// CRITICAL: Show persistent "syncing in progress" notification to warn user not to close app
export async function showSyncInProgressNotification(count: number) {
  if (count <= 0) return;
  try {
    await ensureNotificationPermissions();
    await setupNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: 'sync-in-progress',
      content: {
        title: '📤 Syncing Location Data',
        body: `Uploading ${count} pending location${count > 1 ? 's' : ''}. Please DO NOT close the app until sync completes.`,
        sound: undefined,
        sticky: true,
        priority: (Notifications as any).AndroidNotificationPriority?.MAX,
      },
      trigger: Platform.OS === 'android' ? ({ channelId: 'vts-alerts' } as any) : null,
    });
  } catch (e) {
    console.warn('Sync-in-progress notification failed:', (e as any)?.message);
  }
}

export async function cancelSyncInProgressNotification() {
  try { await Notifications.cancelScheduledNotificationAsync('sync-in-progress'); } catch (_) {}
}

export async function showSyncCompleteNotification(count: number) {
  if (count <= 0) return;
  try {
    await ensureNotificationPermissions();
    await setupNotificationChannel();
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '✓ All Synced',
        body: `${count} pending location${count > 1 ? 's' : ''} successfully uploaded to the server.`,
        sound: 'default',
      },
      trigger: Platform.OS === 'android' ? ({ channelId: 'vts-reminders' } as any) : null,
    });
  } catch (_) {}
}

// Verify filesystem is writable by writing/reading a small test file at startup.
// Runs once during app init to ensure the overflow spillover will work when needed.
export async function verifyFilesystemAccess(): Promise<boolean> {
  try {
    const FileSystem = require('expo-file-system/legacy'); // SDK 54: classic API moved to /legacy
    const testPath = (FileSystem.documentDirectory || '') + 'vts_fs_test.txt';
    await FileSystem.writeAsStringAsync(testPath, 'ok');
    const content = await FileSystem.readAsStringAsync(testPath);
    await FileSystem.deleteAsync(testPath, { idempotent: true });
    return content === 'ok';
  } catch (err) {
    console.error('[Filesystem] Self-test failed:', (err as any)?.message);
    return false;
  }
}
