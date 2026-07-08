import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { API_BASE_URL } from '@/src/lib/config';
import { useAuth } from '@/src/lib/auth';
import { ensurePermissions } from '@/src/lib/permissions';

type UiState = 'starting' | 'idle' | 'tracking' | 'blocked';

export default function Home() {
  const { user, token, signOut } = useAuth();
  const [uiState, setUiState] = useState<UiState>('starting');
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<VehicleTracker.TrackerStatus | null>(null);
  const [lastFix, setLastFix] = useState<VehicleTracker.LocationEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const started = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await VehicleTracker.getStatus());
    } catch {
      // ignore
    }
  }, []);

  // One-time bootstrap: permissions -> configure -> start.
  useEffect(() => {
    if (started.current || !user || !token) return;
    started.current = true;

    (async () => {
      if (!VehicleTracker.isSupported) {
        setUiState('idle');
        setPermMsg('Background tracking runs on Android only. Build a dev client and run on a device.');
        return;
      }
      const perm = await ensurePermissions();
      if (!perm.ok) {
        setUiState('blocked');
        setPermMsg(perm.message ?? 'Permissions required.');
        return;
      }
      await VehicleTracker.configure(API_BASE_URL, token, user._id);
      await VehicleTracker.start();
      setUiState('idle');
      refreshStatus();
    })();
  }, [user, token, refreshStatus]);

  // Live event subscriptions.
  useEffect(() => {
    const subs = [
      VehicleTracker.addStateListener((e) => {
        if (e.state === 'tracking') setUiState('tracking');
        else setUiState('idle');
        refreshStatus();
      }),
      VehicleTracker.addLocationListener((e) => {
        setLastFix(e);
        setUiState('tracking');
      }),
      VehicleTracker.addTripEndListener(() => {
        setUiState('idle');
        refreshStatus();
      }),
    ];
    return () => subs.forEach((s) => s?.remove());
  }, [refreshStatus]);

  // Poll status every 4s while the screen is open.
  useEffect(() => {
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const onRefresh = async () => {
    setRefreshing(true);
    await VehicleTracker.flushNow();
    await refreshStatus();
    setRefreshing(false);
  };

  const retryPermissions = async () => {
    const perm = await ensurePermissions();
    if (perm.ok && token && user) {
      await VehicleTracker.configure(API_BASE_URL, token, user._id);
      await VehicleTracker.start();
      setPermMsg(null);
      setUiState('idle');
    } else {
      setPermMsg(perm.message ?? 'Permissions required.');
    }
  };

  const doSignOut = async () => {
    await signOut();
    router.replace('/login');
  };

  const dotColor =
    uiState === 'tracking' ? '#31d07a' : uiState === 'blocked' ? '#ff6b6b' : '#f5b93b';
  const headline =
    uiState === 'tracking'
      ? 'Trip in progress'
      : uiState === 'blocked'
        ? 'Action needed'
        : uiState === 'starting'
          ? 'Starting…'
          : 'Ready — auto-tracking on';
  const sub =
    uiState === 'tracking'
      ? 'Your location is being recorded.'
      : uiState === 'blocked'
        ? permMsg ?? ''
        : 'Just drive. A trip starts automatically above 5 km/h.';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.hi}>Hi, {user?.name?.split(' ')[0] ?? 'Driver'}</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </View>
        <TouchableOpacity onPress={doSignOut}>
          <Text style={styles.signout}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.statusCard}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={styles.headline}>{headline}</Text>
        <Text style={styles.subline}>{sub}</Text>

        {uiState === 'blocked' && (
          <TouchableOpacity style={styles.retryBtn} onPress={retryPermissions}>
            <Text style={styles.retryText}>Grant permissions</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.grid}>
        <Stat label="Speed" value={lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '—'} />
        <Stat label="Queued offline" value={String(status?.queued ?? 0)} />
        <Stat
          label="Latitude"
          value={lastFix ? lastFix.lat.toFixed(5) : '—'}
        />
        <Stat
          label="Longitude"
          value={lastFix ? lastFix.lon.toFixed(5) : '—'}
        />
      </View>

      <View style={styles.infoCard}>
        <Row k="Tracking engine" v={status?.enabled ? 'Running (native service)' : 'Stopped'} />
        <Row k="Current trip" v={status?.currentTripId ? status.currentTripId.slice(0, 8) + '…' : 'none'} />
        <Row k="Server" v={API_BASE_URL} />
      </View>

      <TouchableOpacity style={styles.syncBtn} onPress={onRefresh}>
        <Text style={styles.syncText}>Force sync now</Text>
      </TouchableOpacity>

      <Text style={styles.note}>
        You can close the app — tracking keeps running in the background and uploads
        automatically when you have internet.
      </Text>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowKey}>{k}</Text>
      <Text style={styles.rowVal} numberOfLines={1}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1220' },
  content: { padding: 20, paddingTop: 64, gap: 16 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  hi: { color: '#fff', fontSize: 22, fontWeight: '800' },
  email: { color: '#8a94a6', fontSize: 13, marginTop: 2 },
  signout: { color: '#4da3ff', fontSize: 15, fontWeight: '600' },
  statusCard: { backgroundColor: '#131c2e', borderRadius: 20, padding: 24, alignItems: 'flex-start' },
  dot: { width: 14, height: 14, borderRadius: 7, marginBottom: 12 },
  headline: { color: '#fff', fontSize: 24, fontWeight: '800' },
  subline: { color: '#8a94a6', fontSize: 14, marginTop: 6 },
  retryBtn: { backgroundColor: '#2f7bff', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 12, marginTop: 16 },
  retryText: { color: '#fff', fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  stat: {
    flexGrow: 1,
    flexBasis: '47%',
    backgroundColor: '#131c2e',
    borderRadius: 16,
    padding: 18,
  },
  statValue: { color: '#fff', fontSize: 22, fontWeight: '800' },
  statLabel: { color: '#8a94a6', fontSize: 13, marginTop: 4 },
  infoCard: { backgroundColor: '#131c2e', borderRadius: 16, padding: 18, gap: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowKey: { color: '#8a94a6', fontSize: 14 },
  rowVal: { color: '#dbe4f3', fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  syncBtn: { backgroundColor: '#1c2942', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  syncText: { color: '#4da3ff', fontWeight: '700', fontSize: 15 },
  note: { color: '#6b7688', fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 4 },
});
