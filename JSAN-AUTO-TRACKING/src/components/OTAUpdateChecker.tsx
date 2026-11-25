import { useEffect, useState } from 'react';
import { Alert, Modal, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import * as Updates from 'expo-updates';
import FontAwesome from '@expo/vector-icons/FontAwesome';

/**
 * OTA Update Checker - Shows current version and allows manual update check
 * 
 * This helps drivers and testers verify that OTA updates are working without confusion.
 * Shows:
 * - Current app version
 * - Last update check time
 * - Manual "Check for Updates" button
 * - Update status (checking/downloading/ready)
 */

export function OTAUpdateChecker({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [checking, setChecking] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentVersion = Updates.manifest?.version || Updates.runtimeVersion || '1.0.29';
  const updateId = Updates.updateId?.slice(0, 8) || 'unknown';

  const checkForUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      const update = await Updates.checkForUpdateAsync();
      setLastChecked(new Date());
      
      if (update.isAvailable) {
        setUpdateAvailable(true);
        // Automatically start downloading
        setDownloading(true);
        await Updates.fetchUpdateAsync();
        setDownloading(false);
        
        Alert.alert(
          '✅ Update Ready',
          'A new update has been downloaded. The app will reload to apply it.',
          [
            { text: 'Not Now', style: 'cancel', onPress: () => setUpdateAvailable(false) },
            { 
              text: 'Reload Now', 
              style: 'default',
              onPress: async () => {
                await Updates.reloadAsync();
              }
            }
          ]
        );
      } else {
        Alert.alert('✅ Up to Date', 'You have the latest version.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to check for updates');
      Alert.alert('❌ Update Check Failed', 'Could not check for updates. Please try again later.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>App Updates</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <FontAwesome name="times" size={22} color="#64748b" />
            </TouchableOpacity>
          </View>

          <View style={s.section}>
            <Text style={s.label}>Current Version</Text>
            <Text style={s.value}>{currentVersion}</Text>
            <Text style={s.meta}>Update ID: {updateId}</Text>
          </View>

          {lastChecked && (
            <View style={s.section}>
              <Text style={s.label}>Last Checked</Text>
              <Text style={s.value}>{lastChecked.toLocaleTimeString()}</Text>
            </View>
          )}

          {error && (
            <View style={[s.section, s.errorBox]}>
              <Text style={s.errorText}>⚠️ {error}</Text>
            </View>
          )}

          <TouchableOpacity 
            style={[s.button, (checking || downloading) && s.buttonDisabled]} 
            onPress={checkForUpdates}
            disabled={checking || downloading}
          >
            {checking ? (
              <>
                <ActivityIndicator color="#ffffff" size="small" />
                <Text style={s.buttonText}>Checking for updates...</Text>
              </>
            ) : downloading ? (
              <>
                <ActivityIndicator color="#ffffff" size="small" />
                <Text style={s.buttonText}>Downloading update...</Text>
              </>
            ) : (
              <>
                <FontAwesome name="refresh" size={16} color="#ffffff" />
                <Text style={s.buttonText}>Check for Updates</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={s.info}>
            <FontAwesome name="info-circle" size={14} color="#64748b" />
            <Text style={s.infoText}>
              Updates download automatically when you open the app. Use this to manually check right now.
            </Text>
          </View>

          {updateAvailable && (
            <View style={[s.section, s.successBox]}>
              <Text style={s.successText}>✅ Update ready! Reload to apply.</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { 
    flex: 1, 
    backgroundColor: 'rgba(15,23,42,0.5)', 
    justifyContent: 'flex-end' 
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 30,
    maxHeight: '75%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  value: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0f172a',
  },
  meta: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#7c3aed',
    paddingVertical: 14,
    borderRadius: 12,
    marginBottom: 16,
  },
  buttonDisabled: {
    backgroundColor: '#a78bfa',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
  info: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f1f5f9',
    borderRadius: 10,
  },
  infoText: {
    flex: 1,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 17,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    padding: 12,
  },
  errorText: {
    fontSize: 13,
    color: '#dc2626',
    fontWeight: '600',
  },
  successBox: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
    borderRadius: 10,
    padding: 12,
  },
  successText: {
    fontSize: 13,
    color: '#059669',
    fontWeight: '600',
  },
});
