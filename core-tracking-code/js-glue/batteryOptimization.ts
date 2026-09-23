import { Platform, Alert, AppState, Linking } from 'react-native';
import Constants from 'expo-constants';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Battery from 'expo-battery';

// Resolve the running app's Android package id at runtime so we can fire the per-app
// REQUEST_IGNORE_BATTERY_OPTIMIZATIONS intent. Falls back to the production package id
// if Constants somehow doesn't expose it (Expo Go, dev client, etc.).
const ANDROID_PACKAGE =
  (Constants as any).expoConfig?.android?.package ||
  (Constants as any).manifest?.android?.package ||
  'com.pavankumarandroid.jsanvts';

let batteryCheckInterval: NodeJS.Timeout | null = null;
let batteryWarningShown = false;

/**
 * CRITICAL: Comprehensive battery optimization check across Android versions
 * Returns true if app is NOT optimized (i.e., tracking will work)
 * Returns false if app IS optimized (tracking may be interrupted)
 *
 * Checks multiple battery optimization mechanisms:
 * - Battery Saver Mode (standard optimization)
 * - Doze Mode (Android 6+) - deep sleep when device unused
 * - App Standby (Android 6+) - restricts background activity
 * - Adaptive Battery (Android 9+) - AI-based optimization
 */
export const checkBatteryOptimization = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') {
    return true;
  }

  try {
    const isOptimized = await Battery.isBatteryOptimizationEnabledAsync();
    console.log('[Battery] Optimization status:', isOptimized ? 'ENABLED (will block tracking)' : 'DISABLED (tracking safe)');
    return !isOptimized; // Return true if NOT optimized (safe), false if optimized (blocked)
  } catch (error) {
    console.error('[Battery] Check failed:', error);
    return false; // Fail-safe: assume optimization is enabled if check fails
  }
};

/**
 * CRITICAL: Aggressive battery optimization monitoring during tracking
 * Checks every 15 seconds to catch mode changes (Doze, Standby, Adaptive Battery, Low Power Mode)
 * Alerts driver IMMEDIATELY if any optimization is detected
 */
export const startBatteryMonitoring = (onBatteryIssue: () => void) => {
  // AGGRESSIVE: Check battery status every 15 seconds to catch changes faster
  batteryCheckInterval = setInterval(async () => {
    try {
      // Comprehensive check covers:
      // Android: optimization, Doze, Standby, Adaptive Battery
      // iOS: Low Power Mode
      const isOptimized = !(await checkBatteryOptimization());

      if (isOptimized && !batteryWarningShown) {
        batteryWarningShown = true;
        console.error('[Battery] ⚠️ OPTIMIZATION DETECTED DURING TRACKING - CRITICAL ALERT!');

        const alertMessage = Platform.OS === 'ios'
          ? 'iOS Low Power Mode is enabled.\n\nThis may reduce location tracking frequency and cause gaps in trip data.\n\nPlease disable Low Power Mode in Settings.'
          : 'Battery optimization (Doze, Standby, or Adaptive Battery) is enabled.\n\nThis WILL interrupt location tracking and cause gaps in your trip data.\n\nPlease disable it NOW in Settings to ensure continuous tracking.';

        Alert.alert(
          '⚠️ CRITICAL: Battery Optimization Active',
          alertMessage,
          [
            { text: 'Go to Settings', onPress: () => openBatteryOptimizationSettings() },
            { text: 'Dismiss', style: 'destructive' }
          ]
        );

        // Callback to notify LocationContext to take additional action if needed
        if (onBatteryIssue) onBatteryIssue();
      } else if (!isOptimized) {
        // Optimization was disabled - clear the warning flag so we can alert again if re-enabled
        batteryWarningShown = false;
      }
    } catch (error) {
      console.error('[Battery] Monitoring error - treating as potential optimization issue:', error);
      // On error, be conservative and assume optimization might be enabled
    }
  }, 15000); // Check every 15 seconds (AGGRESSIVE for reliability)
};

/**
 * Stop monitoring battery optimization
 */
export const stopBatteryMonitoring = () => {
  if (batteryCheckInterval) {
    clearInterval(batteryCheckInterval);
    batteryCheckInterval = null;
    batteryWarningShown = false;
  }
};

export const openBatteryOptimizationSettings = async () => {
  try {
    if (Platform.OS === 'ios') {
      // iOS doesn't expose Low Power Mode toggle deeply — Linking.openSettings() goes
      // to the app's Settings page which is the closest we can get.
      await Linking.openSettings().catch(() => {});
      return;
    }

    // ANDROID: try the per-app whitelist prompt FIRST. The previous primary intent
    // (IGNORE_BATTERY_OPTIMIZATION_SETTINGS) only opens the LIST of all apps and the
    // driver had to manually find/toggle ours — that's the bug. The intent below opens
    // the system dialog "Allow {app} to ignore battery optimization?" directly. Requires
    // the REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission, which is already in app.json.
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
        { data: `package:${ANDROID_PACKAGE}` }
      );
      return;
    } catch (e1) {
      console.warn('[Battery] REQUEST_IGNORE_BATTERY_OPTIMIZATIONS failed:', (e1 as any)?.message);
    }

    // Fallback 1: open the LIST so driver can toggle manually if the per-app prompt
    // is unavailable on this OEM build.
    try {
      await IntentLauncher.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
      return;
    } catch (e2) {
      console.warn('[Battery] IGNORE_BATTERY_OPTIMIZATION_SETTINGS failed:', (e2 as any)?.message);
    }

    // Fallback 2: open this app's details screen so driver can hit "Battery" themselves.
    try {
      await IntentLauncher.startActivityAsync(
        'android.settings.APPLICATION_DETAILS_SETTINGS',
        { data: `package:${ANDROID_PACKAGE}` }
      );
      return;
    } catch (e3) {
      console.warn('[Battery] APPLICATION_DETAILS_SETTINGS failed:', (e3 as any)?.message);
    }

    // Fallback 3: generic battery saver page.
    try {
      await IntentLauncher.startActivityAsync('android.settings.BATTERY_SAVER_SETTINGS');
      return;
    } catch (e4) {
      console.warn('[Battery] BATTERY_SAVER_SETTINGS failed:', (e4 as any)?.message);
    }

    // Last resort: native Linking — guaranteed to open SOMETHING the user can navigate from.
    await Linking.openSettings().catch((e5) => {
      console.error('[Battery] Linking.openSettings() also failed:', e5?.message);
    });
  } catch (error) {
    console.error('[Battery] Critical error opening settings:', error);
    // Last ditch fallback even after the outer try threw
    await Linking.openSettings().catch(() => {});
  }
};

export const requestBatteryOptimizationWhitelist = async () => {
  if (Platform.OS !== 'android') {
    return;
  }

  try {
    // On Android, direct user to battery optimization settings via IntentLauncher
    // since we can't programmatically disable battery optimization
    await openBatteryOptimizationSettings();
  } catch (error) {
    console.error('Failed to open battery optimization settings:', error);
  }
};
