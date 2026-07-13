import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import * as Updates from 'expo-updates';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/src/lib/auth';
import { API_BASE_URL } from '@/src/lib/config';

const APP_VERSION = '1.0.0';

function semverLt(a: string, b: string): boolean {
  const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
  const [a0, a1, a2] = parse(a);
  const [b0, b1, b2] = parse(b);
  if (a0 !== b0) return a0 < b0;
  if (a1 !== b1) return a1 < b1;
  return a2 < b2;
}

/**
 * Checks for an OTA JS bundle update via expo-updates.
 * If one is available, downloads and reloads the app automatically — no APK needed.
 * Falls back silently if running in dev or no update available.
 */
async function checkOtaUpdate(): Promise<boolean> {
  // expo-updates doesn't work in Expo Go / dev client
  if (__DEV__ || !Updates.isEnabled) return false;

  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return false;

    await Updates.fetchUpdateAsync();
    // Reload to apply the new bundle
    await Updates.reloadAsync();
    return true; // unreachable after reload, but satisfies type
  } catch {
    return false;
  }
}

function OtaUpdateOverlay() {
  return (
    <View style={overlay.root}>
      <View style={overlay.card}>
        <Text style={overlay.emoji}>🚛</Text>
        <Text style={overlay.title}>Updating JSAN Fleet</Text>
        <Text style={overlay.sub}>Downloading the latest version…</Text>
        <ActivityIndicator color="#7c3aed" style={{ marginTop: 16 }} size="large" />
      </View>
    </View>
  );
}

const overlay = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f8f7ff',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 36,
    alignItems: 'center',
    width: '80%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 6,
  },
  emoji: { fontSize: 44, marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '800', color: '#0f172a', marginBottom: 6 },
  sub: { fontSize: 14, color: '#64748b', textAlign: 'center' },
});

function AppGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [otaChecking, setOtaChecking] = useState(true);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      // 1. OTA update check — if there's a new bundle, reload happens inside; we never reach the rest
      await checkOtaUpdate();
      setOtaChecking(false);

      // 2. Report this build's version to admin portal (appears in App Updates page automatically)
      fetch(`${API_BASE_URL}/api/app/report-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: APP_VERSION, platform: 'android' }),
      }).catch(() => {});

      // 3. Check if a mandatory native-version update is required (needs new APK)
      fetch(`${API_BASE_URL}/api/app/current`)
        .then(r => r.json())
        .then((data: { version: string | null; downloadUrl?: string; releaseNotes?: string }) => {
          if (data.version && semverLt(APP_VERSION, data.version)) {
            router.replace({
              pathname: '/update',
              params: {
                newVersion: data.version,
                downloadUrl: data.downloadUrl ?? '',
                releaseNotes: data.releaseNotes ?? '',
                currentVersion: APP_VERSION,
              },
            });
          }
        })
        .catch(() => {});
    })();
  }, []);

  if (otaChecking && !__DEV__) return <OtaUpdateOverlay />;
  return <>{children}</>;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AppGate>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="login" />
            <Stack.Screen name="home" />
            <Stack.Screen name="update" options={{ gestureEnabled: false }} />
          </Stack>
        </AppGate>
        <StatusBar style="auto" />
      </ThemeProvider>
    </AuthProvider>
  );
}
