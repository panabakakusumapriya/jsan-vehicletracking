import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/src/lib/auth';
import { API_BASE_URL } from '@/src/lib/config';
import {
  type PermissionHealth,
  getPermissionHealth,
  requestAllPermissions,
  isCriticalHealthOk,
} from '@/src/lib/permissions';

/** Always in sync with app.json — never hardcode this manually. */
const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

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
  amber:      '#d97706',
  amberBg:    '#fffbeb',
  amberBd:    '#fde68a',
  green:      '#059669',
  greenBg:    '#ecfdf5',
  greenBd:    '#a7f3d0',
  red:        '#dc2626',
  redBg:      '#fef2f2',
  redBd:      '#fecaca',
  line:       '#e2e8f0',
};

function semverLt(a: string, b: string): boolean {
  const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}

type UpdateInfo = { newVersion: string; downloadUrl: string; releaseNotes: string };
type RecheckFn = () => Promise<void>;

// ── Shared screens (no router needed) ────────────────────────────────────────

function LoadingScreen({ message }: { message: string }) {
  return (
    <View style={s.center}>
      <View style={s.card}>
        <Text style={s.emoji}>🚛</Text>
        <Text style={s.loadTitle}>JSAN Fleet</Text>
        <Text style={s.loadSub}>{message}</Text>
        <ActivityIndicator color={C.brand} size="large" style={{ marginTop: 16 }} />
      </View>
    </View>
  );
}

function MandatoryUpdateScreen({
  info,
  onRecheck,
}: {
  info: UpdateInfo;
  onRecheck: RecheckFn;
}) {
  const hasLink = !!info.downloadUrl;
  const [rechecking, setRechecking] = useState(false);

  const handleRecheck = async () => {
    setRechecking(true);
    try { await onRecheck(); } finally { setRechecking(false); }
  };

  return (
    <View style={s.center}>
      <View style={s.card}>
        <View style={s.iconWrap}>
          <Text style={s.emoji}>🚛</Text>
        </View>
        <Text style={s.updateTitle}>Update Required</Text>
        <Text style={s.updateBody}>
          A newer version of JSAN Fleet is required to continue.
        </Text>
        <View style={s.versionRow}>
          <View style={s.chip}>
            <Text style={s.chipLabel}>Current</Text>
            <Text style={s.chipValue}>v{APP_VERSION}</Text>
          </View>
          <Text style={s.arrow}>→</Text>
          <View style={[s.chip, s.chipNew]}>
            <Text style={[s.chipLabel, { color: C.brand }]}>Required</Text>
            <Text style={[s.chipValue, { color: C.brand }]}>v{info.newVersion}</Text>
          </View>
        </View>
        {!!info.releaseNotes && (
          <View style={s.notesBox}>
            <Text style={s.notesTitle}>What's new</Text>
            <Text style={s.notesText}>{info.releaseNotes}</Text>
          </View>
        )}
      </View>
      {hasLink ? (
        <TouchableOpacity style={s.btn} activeOpacity={0.85} onPress={() => Linking.openURL(info.downloadUrl)}>
          <Text style={s.btnText}>Download update →</Text>
        </TouchableOpacity>
      ) : (
        <View style={s.btnDisabled}>
          <Text style={s.btnDisabledText}>Download link coming soon — contact your manager</Text>
        </View>
      )}
      <TouchableOpacity
        style={[s.btnGhost, rechecking && { opacity: 0.6 }]}
        onPress={handleRecheck}
        disabled={rechecking}
        activeOpacity={0.75}
      >
        {rechecking
          ? <ActivityIndicator color={C.brand} size="small" />
          : <Text style={s.btnGhostText}>Re-check for updates</Text>
        }
      </TouchableOpacity>
      <Text style={s.hint}>You cannot use the app until you update.</Text>
    </View>
  );
}

// ── Permission health check screen ────────────────────────────────────────────

type PermRow = {
  key: keyof PermissionHealth;
  label: string;
  description: string;
  critical: boolean;
  minVersion?: number; // Android API level; undefined = always shown on Android
};

const PERM_ROWS: PermRow[] = [
  {
    key: 'fineLocation',
    label: 'Precise Location',
    description: 'GPS coordinates for trip recording and live map.',
    critical: true,
  },
  {
    key: 'backgroundLocation',
    label: 'Background Location',
    description: '"Allow all the time" — tracks routes when the app is closed or screen is off.',
    critical: true,
  },
  {
    key: 'activityRecognition',
    label: 'Activity Recognition',
    description: 'Detects driving motion to wake tracking automatically after stops.',
    critical: false,
    minVersion: 29,
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'Required to show the persistent foreground-service notification (Android 13+).',
    critical: false,
    minVersion: 33,
  },
];

function statusColor(s: string) {
  if (s === 'granted') return C.green;
  if (s === 'unavailable') return C.muted2;
  return C.red;
}
function statusBg(s: string) {
  if (s === 'granted') return C.greenBg;
  if (s === 'unavailable') return '#f8fafc';
  return C.redBg;
}
function statusBd(s: string) {
  if (s === 'granted') return C.greenBd;
  if (s === 'unavailable') return C.line;
  return C.redBd;
}
function statusLabel(s: string) {
  if (s === 'granted') return 'Granted';
  if (s === 'blocked') return 'Blocked';
  if (s === 'unavailable') return 'N/A';
  return 'Required';
}
function statusIcon(s: string) {
  if (s === 'granted') return '✓';
  if (s === 'unavailable') return '—';
  return '✕';
}

function PermissionHealthScreen({
  health,
  requesting,
  onRequestAll,
  onContinue,
}: {
  health: PermissionHealth;
  requesting: boolean;
  onRequestAll: () => void;
  onContinue: () => void;
}) {
  const version = Platform.OS === 'android'
    ? (typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10))
    : 0;

  const criticalOk = isCriticalHealthOk(health);
  const allGranted = PERM_ROWS
    .filter(r => r.minVersion === undefined || version >= r.minVersion)
    .every(r => health[r.key] === 'granted' || health[r.key] === 'unavailable');

  const rows = PERM_ROWS.filter(r =>
    Platform.OS === 'android' && (r.minVersion === undefined || version >= r.minVersion)
  );

  return (
    <View style={s.center}>
      <ScrollView style={{ width: '100%' }} contentContainerStyle={ph.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={ph.header}>
          <View style={ph.logoWrap}>
            <Text style={{ fontSize: 36 }}>🛡️</Text>
          </View>
          <Text style={ph.title}>App Health Check</Text>
          <Text style={ph.subtitle}>
            These permissions keep background tracking reliable — especially on Xiaomi, Samsung, and Huawei devices.
          </Text>
        </View>

        {/* Permission rows */}
        <View style={ph.section}>
          <Text style={ph.sectionLabel}>PERMISSIONS</Text>
          {rows.map((row, i) => {
            const status = health[row.key];
            const color = statusColor(status);
            const bg    = statusBg(status);
            const bd    = statusBd(status);
            return (
              <View key={row.key} style={[ph.row, i < rows.length - 1 && ph.rowBorder]}>
                <View style={{ flex: 1 }}>
                  <View style={ph.rowTop}>
                    <Text style={ph.rowLabel}>{row.label}</Text>
                    {row.critical && (
                      <View style={ph.criticalBadge}>
                        <Text style={ph.criticalText}>REQUIRED</Text>
                      </View>
                    )}
                  </View>
                  <Text style={ph.rowDesc}>{row.description}</Text>
                </View>
                <View style={[ph.statusBadge, { backgroundColor: bg, borderColor: bd }]}>
                  <Text style={[ph.statusIcon, { color }]}>{statusIcon(status)}</Text>
                  <Text style={[ph.statusText, { color }]}>{statusLabel(status)}</Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* Battery optimization tip */}
        <View style={ph.tipCard}>
          <View style={ph.tipRow}>
            <Text style={ph.tipIcon}>⚡</Text>
            <View style={{ flex: 1 }}>
              <Text style={ph.tipTitle}>Battery Optimization</Text>
              <Text style={ph.tipBody}>
                Disable battery optimization for JSAN Fleet so Android doesn't kill the tracking service overnight.
              </Text>
            </View>
          </View>
          <TouchableOpacity style={ph.tipBtn} onPress={() => Linking.openSettings()}>
            <Text style={ph.tipBtnText}>Open App Settings →</Text>
          </TouchableOpacity>
        </View>

        {/* Blocked explanation */}
        {!criticalOk && (
          <View style={[ph.tipCard, { backgroundColor: C.redBg, borderColor: C.redBd }]}>
            <Text style={[ph.tipTitle, { color: C.red }]}>Location access required</Text>
            <Text style={[ph.tipBody, { marginTop: 4 }]}>
              Precise location + "Allow all the time" are needed for trip tracking. Without these, the app cannot record any routes.
            </Text>
          </View>
        )}

        {/* Buttons */}
        {!allGranted && (
          <TouchableOpacity
            style={[ph.grantBtn, requesting && { opacity: 0.6 }]}
            activeOpacity={0.85}
            onPress={onRequestAll}
            disabled={requesting}
          >
            {requesting
              ? <ActivityIndicator color={C.white} />
              : <Text style={ph.grantBtnText}>Grant All Permissions</Text>
            }
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[ph.continueBtn, !criticalOk && ph.continueBtnDisabled]}
          activeOpacity={criticalOk ? 0.85 : 1}
          onPress={criticalOk ? onContinue : undefined}
        >
          <Text style={[ph.continueBtnText, !criticalOk && { color: C.muted2 }]}>
            {criticalOk ? 'Continue to Login →' : 'Grant required permissions to continue'}
          </Text>
        </TouchableOpacity>

        <Text style={[s.hint, { marginTop: 8, marginBottom: 32 }]}>
          Permissions can be managed anytime in Android Settings.
        </Text>
      </ScrollView>
    </View>
  );
}

// ── Root layout ───────────────────────────────────────────────────────────────

type AppState =
  | 'checking'           // running OTA + version checks
  | 'ota-downloading'    // found an OTA update, downloading
  | 'mandatory-update'   // server requires a newer APK
  | 'permission-check'   // show health gate before login
  | 'ready';             // all good, show the app

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [appState, setAppState] = useState<AppState>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [health, setHealth] = useState<PermissionHealth>({
    fineLocation: 'denied',
    backgroundLocation: 'denied',
    activityRecognition: 'denied',
    notifications: 'denied',
  });
  const [requesting, setRequesting] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      // 1. OTA update check (JS bundle — no APK needed)
      if (!__DEV__ && Updates.isEnabled) {
        try {
          const result = await Updates.checkForUpdateAsync();
          if (result.isAvailable) {
            setAppState('ota-downloading');
            await Updates.fetchUpdateAsync();
            await Updates.reloadAsync();
            return;
          }
        } catch { /* offline or error — continue */ }
      }

      // 2. Report this build's version to the admin portal
      fetch(`${API_BASE_URL}/api/app/report-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: APP_VERSION, platform: Platform.OS }),
      }).catch(() => {});

      // 3. Check if a mandatory native-version update is required
      try {
        const res = await fetch(`${API_BASE_URL}/api/app/current?platform=${Platform.OS}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data: { version: string | null; downloadUrl?: string; releaseNotes?: string } = await res.json();
        if (data.version && typeof data.version === 'string' && semverLt(APP_VERSION, data.version)) {
          setUpdateInfo({
            newVersion: data.version,
            downloadUrl: data.downloadUrl ?? '',
            releaseNotes: data.releaseNotes ?? '',
          });
          setAppState('mandatory-update');
          return;
        }
      } catch { /* offline — allow access */ }

      // 4. Check permission health (Android only — skip gate on web/iOS)
      if (Platform.OS === 'android') {
        const h = await getPermissionHealth();
        setHealth(h);
        // If all critical permissions are already granted, skip the health screen
        if (isCriticalHealthOk(h)) {
          setAppState('ready');
        } else {
          setAppState('permission-check');
        }
      } else {
        setAppState('ready');
      }
    })();
  }, []);

  /** Re-fetch /api/app/current — lets user unblock if admin deactivated the requirement. */
  const handleRecheck = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/app/current?platform=${Platform.OS}`);
      if (!res.ok) return; // keep showing screen, couldn't verify
      const data: { version: string | null } = await res.json();
      // If no active required version, or we now meet it — proceed
      if (!data.version || !semverLt(APP_VERSION, data.version)) {
        setAppState('permission-check');
      }
      // else stay on update screen — requirement still active
    } catch {
      // network error — stay on screen
    }
  };

  const handleRequestAll = async () => {
    setRequesting(true);
    const h = await requestAllPermissions();
    setHealth(h);
    setRequesting(false);
    // Auto-advance if critical permissions now granted
    if (isCriticalHealthOk(h)) {
      // Small delay so user sees the green status before navigating
      setTimeout(() => setAppState('ready'), 600);
    }
  };

  const handleContinue = () => setAppState('ready');

  // ── Gated screens (before navigator mounts) ──

  if (appState === 'checking') return <LoadingScreen message="Starting up…" />;
  if (appState === 'ota-downloading') return <LoadingScreen message="Downloading update…" />;
  if (appState === 'mandatory-update' && updateInfo) return <MandatoryUpdateScreen info={updateInfo} onRecheck={handleRecheck} />;
  if (appState === 'permission-check') {
    return (
      <PermissionHealthScreen
        health={health}
        requesting={requesting}
        onRequestAll={handleRequestAll}
        onContinue={handleContinue}
      />
    );
  }

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="login" />
          <Stack.Screen name="home" />
          <Stack.Screen name="map" />
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </AuthProvider>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  center: {
    flex: 1, backgroundColor: C.bg,
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  card: {
    backgroundColor: C.white, borderRadius: 20, padding: 28,
    alignItems: 'center', width: '100%',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08, shadowRadius: 16, elevation: 6, marginBottom: 16,
  },
  iconWrap: {
    width: 76, height: 76, borderRadius: 22,
    backgroundColor: C.brandLight, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16, borderWidth: 1.5, borderColor: 'rgba(124,58,237,0.15)',
  },
  emoji: { fontSize: 40, marginBottom: 8 },
  loadTitle: { fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 4 },
  loadSub: { fontSize: 14, color: C.muted },
  updateTitle: { fontSize: 22, fontWeight: '800', color: C.text, marginBottom: 10, textAlign: 'center' },
  updateBody: { fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  versionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 20 },
  chip: {
    alignItems: 'center', backgroundColor: '#f1f5f9',
    borderRadius: 12, paddingHorizontal: 18, paddingVertical: 10,
    borderWidth: 1, borderColor: C.line,
  },
  chipNew: { backgroundColor: C.brandLight, borderColor: 'rgba(124,58,237,0.2)' },
  chipLabel: { fontSize: 10, fontWeight: '600', color: C.muted2, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  chipValue: { fontSize: 17, fontWeight: '800', color: C.text },
  arrow: { fontSize: 20, color: C.muted2 },
  notesBox: {
    width: '100%', backgroundColor: '#f8fafc',
    borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.line,
  },
  notesTitle: { fontSize: 11, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  notesText: { fontSize: 13.5, color: C.text, lineHeight: 20 },
  btn: {
    width: '100%', backgroundColor: C.brand, borderRadius: 14,
    paddingVertical: 16, alignItems: 'center', marginBottom: 12,
    shadowColor: C.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
  },
  btnText: { color: C.white, fontSize: 16, fontWeight: '700' },
  btnDisabled: {
    width: '100%', backgroundColor: '#f1f5f9', borderRadius: 14,
    paddingVertical: 16, alignItems: 'center', marginBottom: 12,
    borderWidth: 1, borderColor: C.line,
  },
  btnDisabledText: { color: C.muted, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  btnGhost: {
    width: '100%', borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', marginBottom: 10, minHeight: 46, justifyContent: 'center',
  },
  btnGhostText: { color: C.brand, fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 12, color: C.muted2, textAlign: 'center' },
});

const ph = StyleSheet.create({
  scroll: { padding: 20, paddingTop: 60 },

  header: { alignItems: 'center', marginBottom: 28 },
  logoWrap: {
    width: 80, height: 80, borderRadius: 24,
    backgroundColor: C.brandLight, alignItems: 'center', justifyContent: 'center',
    marginBottom: 16, borderWidth: 1.5, borderColor: 'rgba(124,58,237,0.18)',
    shadowColor: C.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 5,
  },
  title: { fontSize: 24, fontWeight: '900', color: C.text, letterSpacing: -0.5, marginBottom: 8 },
  subtitle: { fontSize: 13.5, color: C.muted, textAlign: 'center', lineHeight: 20 },

  section: {
    backgroundColor: C.white, borderRadius: 20, borderWidth: 1,
    borderColor: C.line, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05, shadowRadius: 8, elevation: 3,
    overflow: 'hidden',
  },
  sectionLabel: {
    fontSize: 10.5, fontWeight: '700', color: C.muted2,
    letterSpacing: 0.8, textTransform: 'uppercase',
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4,
  },
  row: { paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  rowLabel: { fontSize: 14.5, fontWeight: '700', color: C.text },
  rowDesc: { fontSize: 12.5, color: C.muted, lineHeight: 17 },
  criticalBadge: {
    backgroundColor: '#fef2f2', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2,
    borderWidth: 1, borderColor: '#fecaca',
  },
  criticalText: { fontSize: 9, fontWeight: '800', color: C.red, letterSpacing: 0.4 },

  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 10, borderWidth: 1, minWidth: 80, justifyContent: 'center',
  },
  statusIcon: { fontSize: 12, fontWeight: '900' },
  statusText: { fontSize: 11.5, fontWeight: '700' },

  tipCard: {
    backgroundColor: C.amberBg, borderRadius: 16, borderWidth: 1,
    borderColor: C.amberBd, padding: 16, marginBottom: 12,
  },
  tipRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  tipIcon: { fontSize: 20 },
  tipTitle: { fontSize: 13.5, fontWeight: '700', color: C.text, marginBottom: 3 },
  tipBody: { fontSize: 12.5, color: C.text2, lineHeight: 18 },
  tipBtn: {
    backgroundColor: C.amber, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  tipBtnText: { color: C.white, fontSize: 13, fontWeight: '700' },

  grantBtn: {
    backgroundColor: C.brand, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginBottom: 10,
    shadowColor: C.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 10, elevation: 5,
  },
  grantBtnText: { color: C.white, fontSize: 16, fontWeight: '800' },

  continueBtn: {
    backgroundColor: C.white, borderRadius: 14, paddingVertical: 15,
    alignItems: 'center', borderWidth: 1.5, borderColor: C.brand,
  },
  continueBtnDisabled: { borderColor: C.line, backgroundColor: '#f8fafc' },
  continueBtnText: { color: C.brand, fontSize: 15, fontWeight: '700' },
});
