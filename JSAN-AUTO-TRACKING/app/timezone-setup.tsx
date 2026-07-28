import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { useAuth } from '@/src/lib/auth';
import { apiUpdateTimezone } from '@/src/lib/api';
import { reverseGeocode, TIMEZONE_OPTIONS } from '@/src/lib/timezone';

const C = {
  brand:      '#7c3aed',
  brandLight: '#f5f3ff',
  brandDeep:  '#5b21b6',
  bg:         '#f8f7ff',
  text:       '#0f172a',
  text2:      '#374151',
  muted:      '#64748b',
  muted2:     '#94a3b8',
  white:      '#ffffff',
  green:      '#059669',
  greenBg:    '#ecfdf5',
  greenBd:    '#a7f3d0',
  amber:      '#d97706',
  amberBg:    '#fffbeb',
  line:       '#e2e8f0',
};

export default function TimezoneSetup() {
  const { token, user, refreshUser } = useAuth();
  const [detecting, setDetecting] = useState(true);
  const [selectedTz, setSelectedTz] = useState<string>('');
  const [detectedCountry, setDetectedCountry] = useState<string>('');
  const [detectedLocation, setDetectedLocation] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Try to get current position
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') {
          // Fall back to device timezone
          setSelectedTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
          setDetecting(false);
          return;
        }

        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        // Reverse geocode with LocationIQ
        const result = await reverseGeocode(loc.coords.latitude, loc.coords.longitude);
        if (result) {
          setSelectedTz(result.timezone);
          setDetectedCountry(result.country);
          setDetectedLocation(result.displayName);
        } else {
          // Fallback to device timezone
          setSelectedTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
        }
      } catch {
        setSelectedTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
      } finally {
        setDetecting(false);
      }
    })();
  }, []);

  const handleConfirm = async () => {
    if (!selectedTz || !token) return;
    setSaving(true);
    setError(null);
    try {
      await apiUpdateTimezone(token, {
        timezone: selectedTz,
        country: detectedCountry || undefined,
      });
      // Also set timezone in the native tracking module
      await VehicleTracker.setTimezone(selectedTz);
      // Refresh user in SecureStore so the auth gate doesn't loop back here
      await refreshUser();
      router.replace('/home');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save timezone');
    } finally {
      setSaving(false);
    }
  };

  if (detecting) {
    return (
      <View style={s.center}>
        <View style={s.card}>
          <Text style={{ fontSize: 36, marginBottom: 12 }}>🌍</Text>
          <Text style={s.title}>Detecting your location...</Text>
          <Text style={s.subtitle}>
            Using GPS to determine your timezone automatically
          </Text>
          <ActivityIndicator color={C.brand} size="large" style={{ marginTop: 16 }} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.center}>
      <ScrollView
        style={{ width: '100%' }}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={s.header}>
          <View style={s.iconWrap}>
            <Text style={{ fontSize: 36 }}>🌍</Text>
          </View>
          <Text style={s.title}>Set Your Timezone</Text>
          <Text style={s.subtitle}>
            This controls when tracking starts and stops based on sunrise and sunset at your location.
          </Text>
        </View>

        {/* Auto-detected info */}
        {detectedCountry ? (
          <View style={s.detectedCard}>
            <View style={s.detectedRow}>
              <Text style={s.detectedIcon}>📍</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.detectedLabel}>Auto-detected location</Text>
                <Text style={s.detectedValue}>{detectedCountry}</Text>
                {detectedLocation ? (
                  <Text style={s.detectedSub} numberOfLines={2}>{detectedLocation}</Text>
                ) : null}
              </View>
            </View>
            <View style={[s.detectedRow, { marginTop: 8 }]}>
              <Text style={s.detectedIcon}>🕐</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.detectedLabel}>Detected timezone</Text>
                <Text style={s.detectedValue}>{selectedTz}</Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* Timezone picker */}
        <View style={s.pickerSection}>
          <Text style={s.sectionLabel}>SELECT TIMEZONE</Text>
          <View style={s.pickerWrap}>
            <Picker
              selectedValue={selectedTz}
              onValueChange={(val) => setSelectedTz(val)}
              style={Platform.OS === 'android' ? s.pickerAndroid : undefined}
            >
              {TIMEZONE_OPTIONS.map((tz) => (
                <Picker.Item key={tz.value} label={tz.label} value={tz.value} />
              ))}
            </Picker>
          </View>
          <Text style={s.pickerHint}>
            Your timezone determines sunrise/sunset times for automatic tracking control.
          </Text>
        </View>

        {/* Error */}
        {error ? (
          <View style={s.errorBox}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : null}

        {/* Confirm button */}
        <TouchableOpacity
          style={[s.btn, saving && { opacity: 0.6 }]}
          activeOpacity={0.85}
          onPress={handleConfirm}
          disabled={saving || !selectedTz}
        >
          {saving ? (
            <ActivityIndicator color={C.white} />
          ) : (
            <Text style={s.btnText}>Confirm & Continue →</Text>
          )}
        </TouchableOpacity>

        <Text style={s.hint}>
          You can change your timezone later in the app settings.
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  center: {
    flex: 1, backgroundColor: C.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  scroll: { padding: 20, paddingTop: 60 },
  card: {
    backgroundColor: C.white, borderRadius: 20, padding: 28,
    alignItems: 'center', width: '100%', maxWidth: 400,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08, shadowRadius: 16, elevation: 6,
  },
  header: { alignItems: 'center', marginBottom: 24 },
  iconWrap: {
    width: 80, height: 80, borderRadius: 24,
    backgroundColor: C.brandLight, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16, borderWidth: 1.5, borderColor: 'rgba(124,58,237,0.18)',
    shadowColor: C.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 5,
  },
  title: { fontSize: 24, fontWeight: '900', color: C.text, letterSpacing: -0.5, marginBottom: 8 },
  subtitle: { fontSize: 13.5, color: C.muted, textAlign: 'center', lineHeight: 20 },

  detectedCard: {
    backgroundColor: C.greenBg, borderRadius: 16, borderWidth: 1,
    borderColor: C.greenBd, padding: 16, marginBottom: 16,
  },
  detectedRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  detectedIcon: { fontSize: 18, marginTop: 2 },
  detectedLabel: { fontSize: 11, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  detectedValue: { fontSize: 15, fontWeight: '700', color: C.text, marginTop: 2 },
  detectedSub: { fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 16 },

  pickerSection: {
    backgroundColor: C.white, borderRadius: 16, borderWidth: 1,
    borderColor: C.line, padding: 16, marginBottom: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 8, elevation: 3,
  },
  sectionLabel: {
    fontSize: 10.5, fontWeight: '700', color: C.muted2,
    letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8,
  },
  pickerWrap: {
    borderRadius: 12, borderWidth: 1, borderColor: C.line,
    backgroundColor: '#f9fafb', overflow: 'hidden',
  },
  pickerAndroid: { color: C.text },
  pickerHint: { fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 17 },

  errorBox: {
    backgroundColor: '#fef2f2', borderRadius: 10, borderWidth: 1,
    borderColor: '#fecaca', padding: 12, marginBottom: 12,
  },
  errorText: { color: '#dc2626', fontSize: 13, fontWeight: '500' },

  btn: {
    backgroundColor: C.brand, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10,
    shadowColor: C.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
  },
  btnText: { color: C.white, fontSize: 16, fontWeight: '800' },
  hint: { fontSize: 12, color: C.muted2, textAlign: 'center', marginTop: 4, marginBottom: 32 },
});
