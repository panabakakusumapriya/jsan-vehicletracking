import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
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

const STATE_CONFIG = {
  tracking: { color: '#2ecc71', icon: '●', label: 'Trip in progress', sub: 'Your location is being recorded.' },
  blocked:  { color: '#ff5252', icon: '⚠', label: 'Action needed', sub: '' },
  starting: { color: '#f0a500', icon: '◌', label: 'Starting…', sub: 'Setting up background tracking.' },
  idle:     { color: '#5a9eff', icon: '◎', label: 'Ready — auto-tracking on', sub: 'Just drive. A trip starts automatically above 5 km/h.' },
};

export default function Home() {
  const { user, token, signOut } = useAuth();
  const [uiState, setUiState] = useState<UiState>('starting');
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<VehicleTracker.TrackerStatus | null>(null);
  const [lastFix, setLastFix] = useState<VehicleTracker.LocationEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const started = useRef(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for tracking state
  useEffect(() => {
    if (uiState === 'tracking') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.4, duration: 900, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [uiState, pulseAnim]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await VehicleTracker.getStatus());
    } catch {
      // ignore
    }
  }, []);

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

  const cfg = STATE_CONFIG[uiState];
  const subText = uiState === 'blocked' ? (permMsg ?? '') : cfg.sub;
  const firstName = user?.name?.split(' ')[0] ?? 'Driver';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#5a9eff" />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Good day, {firstName}</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </View>
        <TouchableOpacity onPress={doSignOut} style={styles.signOutBtn}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* Status card */}
      <View style={[styles.statusCard, { borderColor: cfg.color + '33' }]}>
        <View style={styles.statusTop}>
          <View style={styles.dotWrap}>
            <Animated.View style={[styles.dotRing, { backgroundColor: cfg.color + '33', transform: [{ scale: pulseAnim }] }]} />
            <View style={[styles.dot, { backgroundColor: cfg.color }]} />
          </View>
          <View style={styles.statusTextWrap}>
            <Text style={[styles.statusHeadline, { color: cfg.color }]}>{cfg.label}</Text>
            {subText ? <Text style={styles.statusSub}>{subText}</Text> : null}
          </View>
        </View>

        {uiState === 'blocked' && (
          <TouchableOpacity style={[styles.permBtn, { borderColor: cfg.color + '66' }]} onPress={retryPermissions}>
            <Text style={[styles.permBtnText, { color: cfg.color }]}>Grant permissions</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Stats grid */}
      <View style={styles.grid}>
        <StatCard
          icon="⚡"
          label="Speed"
          value={lastFix ? `${Math.round(lastFix.speedKmh)}` : '—'}
          unit={lastFix ? 'km/h' : ''}
        />
        <StatCard
          icon="📡"
          label="Queued offline"
          value={String(status?.queued ?? 0)}
          unit="pts"
        />
        <StatCard
          icon="↕"
          label="Latitude"
          value={lastFix ? lastFix.lat.toFixed(4) : '—'}
          unit=""
        />
        <StatCard
          icon="↔"
          label="Longitude"
          value={lastFix ? lastFix.lon.toFixed(4) : '—'}
          unit=""
        />
      </View>

      {/* Info card */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>System</Text>
        <InfoRow label="Tracking engine" value={status?.enabled ? 'Running' : 'Stopped'} valueColor={status?.enabled ? '#2ecc71' : '#7a8699'} />
        <InfoRow label="Current trip" value={status?.currentTripId ? status.currentTripId.slice(0, 10) + '…' : 'None'} />
        <InfoRow label="Server" value={API_BASE_URL} />
      </View>

      {/* Sync button */}
      <TouchableOpacity style={styles.syncBtn} onPress={onRefresh} activeOpacity={0.7}>
        <Text style={styles.syncIcon}>↻</Text>
        <Text style={styles.syncText}>Force sync now</Text>
      </TouchableOpacity>

      <Text style={styles.note}>
        You can close the app — tracking keeps running in the background and uploads automatically when you have internet.
      </Text>
    </ScrollView>
  );
}

function StatCard({ icon, label, value, unit }: { icon: string; label: string; value: string; unit: string }) {
  return (
    <View style={statStyles.card}>
      <Text style={statStyles.icon}>{icon}</Text>
      <View style={statStyles.row}>
        <Text style={statStyles.value}>{value}</Text>
        {unit ? <Text style={statStyles.unit}>{unit}</Text> : null}
      </View>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={infoStyles.row}>
      <Text style={infoStyles.label}>{label}</Text>
      <Text style={[infoStyles.value, valueColor ? { color: valueColor } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#080e1a' },
  content: { padding: 20, paddingTop: 60, gap: 14 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  greeting: { color: '#e8eef8', fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  email: { color: '#5a6478', fontSize: 13, marginTop: 2 },
  signOutBtn: {
    backgroundColor: '#0f1827',
    borderWidth: 1,
    borderColor: '#1e2d45',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  signOutText: { color: '#5a9eff', fontSize: 13, fontWeight: '600' },
  statusCard: {
    backgroundColor: '#0f1827',
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  statusTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  dotWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  dotRing: { position: 'absolute', width: 22, height: 22, borderRadius: 11 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  statusTextWrap: { flex: 1 },
  statusHeadline: { fontSize: 17, fontWeight: '700', lineHeight: 22 },
  statusSub: { color: '#7a8699', fontSize: 13, marginTop: 4, lineHeight: 18 },
  permBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  permBtnText: { fontWeight: '700', fontSize: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  infoCard: {
    backgroundColor: '#0f1827',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#1e2d45',
    padding: 18,
    gap: 0,
  },
  infoTitle: {
    color: '#5a6478',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  syncBtn: {
    backgroundColor: '#0f1827',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e2d45',
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  syncIcon: { color: '#5a9eff', fontSize: 18, fontWeight: '700' },
  syncText: { color: '#5a9eff', fontWeight: '700', fontSize: 14 },
  note: { color: '#3d4a5e', fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: 20 },
});

const statStyles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexBasis: '47%',
    backgroundColor: '#0f1827',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#1e2d45',
    padding: 16,
    gap: 2,
  },
  icon: { fontSize: 18, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  value: { color: '#e8eef8', fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  unit: { color: '#7a8699', fontSize: 13, fontWeight: '500' },
  label: { color: '#5a6478', fontSize: 12, marginTop: 2 },
});

const infoStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: '#1a2236',
    gap: 12,
  },
  label: { color: '#7a8699', fontSize: 13 },
  value: { color: '#c4cede', fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
