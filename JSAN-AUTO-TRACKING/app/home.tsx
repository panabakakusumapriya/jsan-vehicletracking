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

// Brand palette
const C = {
  brand:     '#7c3aed',
  brandDeep: '#5b21b6',
  brandSoft: '#ede9fe',
  brandMid:  '#a78bfa',
  bg:        '#f7f7fb',
  surface:   '#ffffff',
  border:    '#e9ecf0',
  text:      '#0d0d12',
  text2:     '#374151',
  muted:     '#9ca3af',
  green:     '#059669',
  greenBg:   '#ecfdf5',
  greenBd:   '#a7f3d0',
  amber:     '#d97706',
  amberBg:   '#fffbeb',
  amberBd:   '#fde68a',
  red:       '#dc2626',
  redBg:     '#fef2f2',
  redBd:     '#fecaca',
};

const STATE = {
  tracking: { label: 'Trip in progress',       sub: 'Your location is being recorded.',                              color: C.green, bg: C.greenBg, bd: C.greenBd },
  blocked:  { label: 'Action needed',           sub: '',                                                              color: C.red,   bg: C.redBg,   bd: C.redBd   },
  starting: { label: 'Starting…',              sub: 'Setting up background tracking.',                              color: C.amber, bg: C.amberBg, bd: C.amberBd },
  idle:     { label: 'Ready — auto-tracking',  sub: 'Just drive. A trip starts automatically above 5 km/h.',       color: C.brand, bg: C.brandSoft, bd: '#d8b4fe' },
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

  useEffect(() => {
    if (uiState === 'tracking') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.5, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,   duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
    pulseAnim.setValue(1);
  }, [uiState, pulseAnim]);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await VehicleTracker.getStatus()); } catch {}
  }, []);

  useEffect(() => {
    if (started.current || !user || !token) return;
    started.current = true;
    (async () => {
      if (!VehicleTracker.isSupported) {
        setUiState('idle');
        setPermMsg('Background tracking runs on Android only.');
        return;
      }
      const perm = await ensurePermissions();
      if (!perm.ok) { setUiState('blocked'); setPermMsg(perm.message ?? 'Permissions required.'); return; }
      await VehicleTracker.configure(API_BASE_URL, token, user._id);
      await VehicleTracker.start();
      setUiState('idle');
      refreshStatus();
    })();
  }, [user, token, refreshStatus]);

  useEffect(() => {
    const subs = [
      VehicleTracker.addStateListener(e => { setUiState(e.state === 'tracking' ? 'tracking' : 'idle'); refreshStatus(); }),
      VehicleTracker.addLocationListener(e => { setLastFix(e); setUiState('tracking'); }),
      VehicleTracker.addTripEndListener(() => { setUiState('idle'); refreshStatus(); }),
    ];
    return () => subs.forEach(s => s?.remove());
  }, [refreshStatus]);

  useEffect(() => { const id = setInterval(refreshStatus, 4000); return () => clearInterval(id); }, [refreshStatus]);

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
      setPermMsg(null); setUiState('idle');
    } else {
      setPermMsg(perm.message ?? 'Permissions required.');
    }
  };

  const cfg = STATE[uiState];
  const subText = uiState === 'blocked' ? (permMsg ?? '') : cfg.sub;
  const firstName = user?.name?.split(' ')[0] ?? 'Driver';
  const initials = (user?.name ?? 'D').split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
    >
      {/* ── Header ── */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials}</Text>
          </View>
          <View>
            <Text style={s.greeting}>Good day, {firstName}</Text>
            <Text style={s.email}>{user?.email}</Text>
          </View>
        </View>
        <TouchableOpacity style={s.signOutBtn} onPress={async () => { await signOut(); router.replace('/login'); }}>
          <Text style={s.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* ── Status card ── */}
      <View style={[s.statusCard, { backgroundColor: cfg.bg, borderColor: cfg.bd }]}>
        <View style={s.statusRow}>
          {/* Animated dot */}
          <View style={s.dotArea}>
            <Animated.View style={[s.dotRing, { backgroundColor: cfg.color + '30', transform: [{ scale: pulseAnim }] }]} />
            <View style={[s.dot, { backgroundColor: cfg.color }]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.statusLabel, { color: cfg.color }]}>{cfg.label}</Text>
            {subText ? <Text style={s.statusSub}>{subText}</Text> : null}
          </View>
        </View>
        {uiState === 'blocked' && (
          <TouchableOpacity style={[s.permBtn, { backgroundColor: cfg.color }]} onPress={retryPermissions}>
            <Text style={s.permBtnText}>Grant permissions</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Stats grid ── */}
      <View style={s.grid}>
        <StatTile label="Speed"   value={lastFix ? `${Math.round(lastFix.speedKmh)}` : '—'} unit="km/h"  color={C.brand}   />
        <StatTile label="Queued"  value={String(status?.queued ?? 0)}                         unit="pts"   color="#7c3aed"   />
        <StatTile label="Lat"     value={lastFix ? lastFix.lat.toFixed(4) : '—'}              unit=""      color="#059669"   />
        <StatTile label="Lon"     value={lastFix ? lastFix.lon.toFixed(4) : '—'}              unit=""      color="#d97706"   />
      </View>

      {/* ── System info ── */}
      <View style={s.infoCard}>
        <View style={s.infoHeader}>
          <Text style={s.infoTitle}>System</Text>
          <View style={[s.engineBadge, { backgroundColor: status?.enabled ? C.greenBg : '#f3f4f6' }]}>
            <View style={[s.engineDot, { backgroundColor: status?.enabled ? C.green : C.muted }]} />
            <Text style={[s.engineText, { color: status?.enabled ? C.green : C.muted }]}>
              {status?.enabled ? 'Running' : 'Stopped'}
            </Text>
          </View>
        </View>
        <InfoRow label="Active trip"  value={status?.currentTripId ? '#' + status.currentTripId.slice(-6) : 'None'} />
        <InfoRow label="Server"       value={API_BASE_URL} last />
      </View>

      {/* ── Sync ── */}
      <TouchableOpacity style={s.syncBtn} onPress={onRefresh} activeOpacity={0.75}>
        <Text style={s.syncIcon}>↻</Text>
        <Text style={s.syncText}>Sync now</Text>
      </TouchableOpacity>

      <Text style={s.note}>
        Close the app anytime — tracking continues in the background.
      </Text>
    </ScrollView>
  );
}

/* ── Sub-components ── */
function StatTile({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <View style={[st.tile, { borderTopColor: color }]}>
      <Text style={[st.val, { color }]}>{value}</Text>
      {unit ? <Text style={st.unit}>{unit}</Text> : null}
      <Text style={st.label}>{label}</Text>
    </View>
  );
}

function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[ir.row, last && { borderBottomWidth: 0 }]}>
      <Text style={ir.label}>{label}</Text>
      <Text style={ir.value} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/* ── Styles ── */
const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 64, gap: 12 },

  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: {
    width: 44, height: 44, borderRadius: 14,
    backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center',
    shadowColor: C.brandDeep,
    shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  avatarText:  { color: '#fff', fontSize: 16, fontWeight: '900' },
  greeting:    { color: C.text, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  email:       { color: C.muted, fontSize: 12, marginTop: 2 },
  signOutBtn:  {
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    borderRadius: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  signOutText: { color: C.text2, fontSize: 12.5, fontWeight: '600' },

  statusCard: {
    borderRadius: 20, borderWidth: 1.5, padding: 18, gap: 14,
  },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  dotArea:   { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  dotRing:   { position: 'absolute', width: 24, height: 24, borderRadius: 12 },
  dot:       { width: 12, height: 12, borderRadius: 6 },
  statusLabel: { fontSize: 15.5, fontWeight: '700', lineHeight: 22 },
  statusSub:   { color: C.text2, fontSize: 12.5, marginTop: 4, lineHeight: 18 },
  permBtn:     { borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 2 },
  permBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },

  infoCard: {
    backgroundColor: C.surface, borderRadius: 18, borderWidth: 1,
    borderColor: C.border, padding: 18,
    shadowColor: '#111', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  infoHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  infoTitle:    { color: C.text, fontSize: 13, fontWeight: '700' },
  engineBadge:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  engineDot:    { width: 6, height: 6, borderRadius: 3 },
  engineText:   { fontSize: 11.5, fontWeight: '700' },

  syncBtn: {
    backgroundColor: C.surface, borderRadius: 13, borderWidth: 1, borderColor: C.border,
    paddingVertical: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: '#111', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4, elevation: 2,
  },
  syncIcon: { color: C.brand, fontSize: 19, fontWeight: '800' },
  syncText: { color: C.brand, fontSize: 14, fontWeight: '700' },

  note: { color: C.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: 20 },
});

const st = StyleSheet.create({
  tile: {
    flexGrow: 1, flexBasis: '47%',
    backgroundColor: C.surface, borderRadius: 16,
    borderWidth: 1, borderColor: C.border,
    borderTopWidth: 3, padding: 16,
    shadowColor: '#111', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6, elevation: 2,
  },
  val:   { fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  unit:  { color: C.muted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  label: { color: C.muted, fontSize: 11.5, fontWeight: '600', marginTop: 8, textTransform: 'uppercase', letterSpacing: 0.4 },
});

const ir = StyleSheet.create({
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 12,
  },
  label: { color: C.muted, fontSize: 13 },
  value: { color: C.text2, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
