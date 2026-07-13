import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Updates from 'expo-updates';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/src/lib/auth';
import { API_BASE_URL } from '@/src/lib/config';

const APP_VERSION = '1.0.0';

const C = {
  brand: '#7c3aed',
  brandLight: '#f5f3ff',
  bg: '#f8f7ff',
  text: '#0f172a',
  muted: '#64748b',
  muted2: '#94a3b8',
  white: '#ffffff',
  amber: '#d97706',
  amberBg: '#fffbeb',
  line: '#e2e8f0',
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

// ── Screens rendered directly (no router needed) ──────────────────────────────

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

function MandatoryUpdateScreen({ info }: { info: UpdateInfo }) {
  const hasLink = !!info.downloadUrl;
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

        {/* Version chips */}
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

        {/* Release notes */}
        {!!info.releaseNotes && (
          <View style={s.notesBox}>
            <Text style={s.notesTitle}>What's new</Text>
            <Text style={s.notesText}>{info.releaseNotes}</Text>
          </View>
        )}
      </View>

      {/* Download button */}
      {hasLink ? (
        <TouchableOpacity
          style={s.btn}
          activeOpacity={0.85}
          onPress={() => Linking.openURL(info.downloadUrl)}
        >
          <Text style={s.btnText}>Download update →</Text>
        </TouchableOpacity>
      ) : (
        <View style={s.btnDisabled}>
          <Text style={s.btnDisabledText}>Download link coming soon — contact your manager</Text>
        </View>
      )}

      <Text style={s.hint}>You cannot use the app until you update.</Text>
    </View>
  );
}

// ── Root layout ───────────────────────────────────────────────────────────────

type AppState =
  | 'checking'        // running OTA + version checks
  | 'ota-downloading' // found an OTA update, downloading
  | 'mandatory-update'// server requires a newer APK
  | 'ready';          // all good, show the app

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [appState, setAppState] = useState<AppState>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
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
            await Updates.reloadAsync(); // app restarts — code below never runs
            return;
          }
        } catch { /* offline or error — continue */ }
      }

      // 2. Report this build's version to the admin portal
      fetch(`${API_BASE_URL}/api/app/report-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: APP_VERSION, platform: 'android' }),
      }).catch(() => {});

      // 3. Check if a mandatory native-version update is required
      try {
        const res = await fetch(`${API_BASE_URL}/api/app/current`);
        const data: { version: string | null; downloadUrl?: string; releaseNotes?: string } = await res.json();

        if (data.version && semverLt(APP_VERSION, data.version)) {
          setUpdateInfo({
            newVersion: data.version,
            downloadUrl: data.downloadUrl ?? '',
            releaseNotes: data.releaseNotes ?? '',
          });
          setAppState('mandatory-update');
          return;
        }
      } catch { /* offline — allow access */ }

      setAppState('ready');
    })();
  }, []);

  // Show loading/update screens BEFORE rendering the navigator
  if (appState === 'checking') {
    return <LoadingScreen message="Starting up…" />;
  }
  if (appState === 'ota-downloading') {
    return <LoadingScreen message="Downloading update…" />;
  }
  if (appState === 'mandatory-update' && updateInfo) {
    return <MandatoryUpdateScreen info={updateInfo} />;
  }

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="login" />
          <Stack.Screen name="home" />
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
  hint: { fontSize: 12, color: C.muted2, textAlign: 'center' },
});
