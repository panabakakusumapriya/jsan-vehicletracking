import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  ScrollView,
  Platform,
  Linking,
  AppState
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { detectOEMIssue, openOEMSettings, OEMWarning } from '../services/deviceCompatibility';
import * as Battery from 'expo-battery';

interface PermissionsScreenProps {
  onPermissionsGranted: () => void;
}

const BATTERY_OPT_CONFIRMED_KEY = 'batteryOptConfirmed';
const OEM_ACK_KEY = 'oemWarningAcknowledged';
const PACKAGE_NAME = 'com.pavankumarandroid.jsanvts';

export default function PermissionsScreen({ onPermissionsGranted }: PermissionsScreenProps) {
  const [permissions, setPermissions] = useState({
    location: false,
    backgroundLocation: false,
    batteryOpt: false,
    notifications: false,
  });
  const [isChecking, setIsChecking] = useState(true);
  const [batteryPromptShown, setBatteryPromptShown] = useState(false);
  const [oemWarning, setOemWarning] = useState<OEMWarning | null>(null);
  const [oemAcknowledged, setOemAcknowledged] = useState(false);
  const [oemSettingsOpened, setOemSettingsOpened] = useState(false);

  useEffect(() => {
    (async () => {
      const warning = detectOEMIssue();
      if (warning) {
        setOemWarning(warning);
        const acked = await AsyncStorage.getItem(OEM_ACK_KEY);
        if (acked === 'true') setOemAcknowledged(true);
      } else {
        setOemAcknowledged(true); // No warning = no action needed
      }
    })();
    checkPermissions();
    const interval = setInterval(checkPermissions, 1500);

    // Re-check when app comes back from settings
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkPermissions();
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, []);

  const checkPermissions = async () => {
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();
      const notif = await Notifications.getPermissionsAsync();

      // CRITICAL: Real battery optimization check via expo-battery
      // Returns true if optimization is ENABLED (bad), false if DISABLED (good)
      let batteryOpt = Platform.OS !== 'android';
      if (Platform.OS === 'android') {
        try {
          const isOptimized = await Battery.isBatteryOptimizationEnabledAsync();
          batteryOpt = !isOptimized; // batteryOpt=true means "optimization is off = safe"
        } catch {
          batteryOpt = false; // Fail-safe: assume optimization is on
        }
      }

      const newPerms = {
        location: fg.status === 'granted',
        backgroundLocation: bg.status === 'granted',
        batteryOpt,
        notifications: notif.status === 'granted',
      };
      setPermissions(newPerms);

      // NOTE: batteryOpt is intentionally NOT a hard gate here. There is no battery row in this
      // screen's UI, and it defaults to false on battery-optimized devices, so gating on it
      // permanently trapped new users before login. Battery-optimization exemption is requested at
      // tracking start (startTracking) instead, where it actually matters.
      if (newPerms.location && newPerms.backgroundLocation && newPerms.notifications && oemAcknowledged) {
        setTimeout(() => onPermissionsGranted(), 300);
      }

      setIsChecking(false);
    } catch (e) {
      console.error('Permission check error:', e);
      setIsChecking(false);
    }
  };

  const requestNotifications = async () => {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Notifications Required',
        'VTS needs to send notifications when tracking is interrupted or you have pending data. Please enable notifications in Settings.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }
    setPermissions(p => ({ ...p, notifications: true }));
  };

  const requestLocation = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Location Required',
        'VTS needs location access to track your vehicle. Open Settings to grant it.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }
    setPermissions(p => ({ ...p, location: true }));
  };

  const requestBackgroundLocation = async () => {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Background Location Required',
        'VTS needs background location to track even when the app is closed. Set to "Allow all the time".',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }
    setPermissions(p => ({ ...p, backgroundLocation: true }));
  };

  // Launch the exact per-app battery optimization exemption dialog.
  // Polling verifies real state via expo-battery after user returns.
  const requestBatteryOptimization = async () => {
    if (Platform.OS !== 'android') {
      setPermissions(p => ({ ...p, batteryOpt: true }));
      return;
    }
    setBatteryPromptShown(true);

    // Try 3 intents in order: exact app request → general battery-opt list → app details
    const attempts = [
      { action: 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', data: `package:${PACKAGE_NAME}` },
      { action: 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS', data: undefined },
      { action: 'android.settings.APPLICATION_DETAILS_SETTINGS', data: `package:${PACKAGE_NAME}` },
    ];

    for (const { action, data } of attempts) {
      try {
        await IntentLauncher.startActivityAsync(action as any, data ? { data } : undefined);
        return; // success
      } catch (_) {
        // try next
      }
    }
    Alert.alert('Could not open settings', 'Please go to Settings → Apps → JSAN VTS → Battery → Unrestricted manually.');
  };

  // After the user returns from settings, this button confirms they allowed it.
  // If they haven't, we just re-open the dialog.
  const confirmBatteryAllowed = async () => {
    await AsyncStorage.setItem(BATTERY_OPT_CONFIRMED_KEY, 'true');
    setPermissions(p => ({ ...p, batteryOpt: true }));
  };

  // batteryOpt deliberately excluded — see note above; it has no row here and is handled at
  // tracking start. Gating on it trapped users on battery-optimized devices.
  const allGranted = permissions.location && permissions.backgroundLocation && permissions.notifications && oemAcknowledged;

  const PermissionItem = ({
    icon, title, desc, granted, actionLabel, onAction, showConfirm,
  }: {
    icon: string;
    title: string;
    desc: string;
    granted: boolean;
    actionLabel: string;
    onAction: () => void;
    showConfirm?: boolean;
  }) => (
    <View style={styles.permissionItem}>
      <View style={styles.permissionIcon}>
        <FontAwesome5 name={icon} size={22} color={granted ? '#4CAF50' : '#00578d'} />
      </View>
      <View style={styles.permissionContent}>
        <Text style={styles.permissionTitle}>{title}</Text>
        <Text style={styles.permissionDescription}>{desc}</Text>
        {!granted && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={styles.smallButton} onPress={onAction}>
              <Text style={styles.smallButtonText}>{actionLabel}</Text>
            </TouchableOpacity>
            {showConfirm && (
              <TouchableOpacity style={[styles.smallButton, { backgroundColor: '#4CAF50' }]} onPress={confirmBatteryAllowed}>
                <Text style={styles.smallButtonText}>I Allowed It</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
      <View style={styles.permissionStatus}>
        <FontAwesome5
          name={granted ? 'check-circle' : 'times-circle'}
          size={24}
          color={granted ? '#4CAF50' : '#F44336'}
        />
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <FontAwesome5 name="shield-alt" size={54} color="#FFFFFF" />
          <Text style={styles.title}>Required Permissions</Text>
          <Text style={styles.subtitle}>
            You must grant all three permissions to use VTS. The app tracks your vehicle reliably only with these enabled.
          </Text>
        </View>

        <View style={styles.permissionsContainer}>
          <PermissionItem
            icon="map-marker-alt"
            title="Precise Location"
            desc="Required to track your vehicle position accurately."
            granted={permissions.location}
            actionLabel="Grant"
            onAction={requestLocation}
          />
          <PermissionItem
            icon="clock"
            title="Background Location"
            desc="Select 'Allow all the time' so tracking continues in the background."
            granted={permissions.backgroundLocation}
            actionLabel="Grant"
            onAction={requestBackgroundLocation}
          />
          <PermissionItem
            icon="bell"
            title="Notifications"
            desc="Required so we can alert you about tracking status, pending uploads, and lens checks."
            granted={permissions.notifications}
            actionLabel="Grant"
            onAction={requestNotifications}
          />
        </View>

        {!allGranted && (
          <View style={styles.warningBox}>
            <FontAwesome5 name="exclamation-triangle" size={16} color="#FF9800" />
            <Text style={styles.warningText}>
              The app cannot be used until ALL permissions above are granted.
            </Text>
          </View>
        )}

        {oemWarning && !oemAcknowledged && (
          <View style={{
            backgroundColor: '#fff3e0',
            borderLeftWidth: 4,
            borderLeftColor: '#E65100',
            padding: 16,
            margin: 16,
            borderRadius: 8
          }}>
            <Text style={{ color: '#E65100', fontSize: 16, fontWeight: 'bold', marginBottom: 8 }}>
              ⚠️ {oemWarning.title}
            </Text>
            <Text style={{ color: '#333', fontSize: 13, marginBottom: 12, lineHeight: 20 }}>
              Your <Text style={{ fontWeight: 'bold' }}>{oemWarning.brand}</Text> device may stop tracking in the background unless you whitelist JSAN VTS in the OEM settings. Follow these steps:
            </Text>
            {oemWarning.instructions.map((step, i) => (
              <Text key={i} style={{ color: '#555', fontSize: 12, marginBottom: 4, lineHeight: 18 }}>
                {step}
              </Text>
            ))}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              <TouchableOpacity
                style={{
                  flex: 1,
                  backgroundColor: '#E65100',
                  padding: 14,
                  borderRadius: 6,
                  alignItems: 'center'
                }}
                onPress={async () => {
                  await openOEMSettings(oemWarning);
                  setOemSettingsOpened(true);
                }}
              >
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>
                  {oemSettingsOpened ? '↻ Reopen Settings' : '⚙️ Open Settings Now'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  flex: 1,
                  backgroundColor: oemSettingsOpened ? '#4CAF50' : '#ccc',
                  padding: 14,
                  borderRadius: 6,
                  alignItems: 'center'
                }}
                disabled={!oemSettingsOpened}
                onPress={async () => {
                  if (!oemSettingsOpened) {
                    Alert.alert(
                      '⚠️ Open Settings First',
                      'You must open the OEM settings and enable the toggles listed above. Only then can you continue.\n\nThis is critical — if you skip this, tracking will silently stop and your payroll will be inaccurate.',
                      [{ text: 'OK' }]
                    );
                    return;
                  }
                  await AsyncStorage.setItem(OEM_ACK_KEY, 'true');
                  setOemAcknowledged(true);
                }}
              >
                <Text style={{ color: '#fff', fontWeight: 'bold', fontSize: 13 }}>
                  {oemSettingsOpened ? '✓ I\'ve Enabled All' : '(Open Settings first)'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {allGranted && (
          <TouchableOpacity
            style={[styles.button, styles.continueButton]}
            onPress={onPermissionsGranted}
          >
            <FontAwesome5 name="check" size={16} color="#FFFFFF" />
            <Text style={styles.buttonText}>Continue</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0C3B6F' },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  title: {
    fontSize: 26, fontWeight: 'bold', color: '#FFFFFF',
    marginTop: 14, marginBottom: 6, textAlign: 'center',
  },
  subtitle: {
    fontSize: 14, color: '#CBD5E1', textAlign: 'center',
    marginBottom: 16, paddingHorizontal: 12,
  },
  permissionsContainer: {
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 12, padding: 16, marginBottom: 18,
  },
  permissionItem: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#EEEEEE',
  },
  permissionIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#F0F4F8',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 14,
  },
  permissionContent: { flex: 1 },
  permissionTitle: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 3 },
  permissionDescription: { fontSize: 13, color: '#555', lineHeight: 18 },
  permissionStatus: { marginLeft: 10, paddingTop: 6 },
  smallButton: {
    backgroundColor: '#00578d',
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
  },
  smallButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  warningBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,152,0,0.15)',
    borderRadius: 8, padding: 14, gap: 10,
  },
  warningText: { color: '#FFE0B2', fontSize: 13, flex: 1, lineHeight: 18 },
  button: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    padding: 16, borderRadius: 10, gap: 8, marginTop: 12,
  },
  continueButton: { backgroundColor: '#4CAF50' },
  buttonText: { fontSize: 16, fontWeight: 'bold', color: '#FFFFFF' },
});
