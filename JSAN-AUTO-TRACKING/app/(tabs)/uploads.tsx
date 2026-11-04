import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import type { SyncStatus } from '@/modules/vehicle-tracker';
import { useAuth } from '@/src/lib/auth';
import { flushMarkerQueue, pendingMarkerCount } from '@/src/lib/markerQueue';
import { timeLeftText } from '@/src/lib/tripSync';

/**
 * The Sync tab: what is still on this phone and not yet on the server — trip points and map
 * markers — so a driver can see their trips are safe, and make sure before they uninstall, change
 * phones or hand the phone over. Uploading happens by itself; this shows it, says plainly what is
 * wrong when it cannot happen (no internet, login expired, server down), and has "Sync now".
 *
 * Its route is /uploads because /sync is the sign-out screen (app/sync.tsx), which shares the
 * same wording.
 */

const C = {
  brand: '#7c3aed',
  brandSoft: '#ede9fe',
  bg: '#f7f7fb',
  surface: '#ffffff',
  border: '#e9ecf0',
  text: '#0d0d12',
  text2: '#374151',
  muted: '#6b7280',
  green: '#059669',
  greenBg: '#ecfdf5',
  amber: '#d97706',
  amberBg: '#fffbeb',
  red: '#dc2626',
  redBg: '#fef2f2',
};

const POLL_MS = 1_500;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : 'over a day ago';
}

export default function SyncTab() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [markers, setMarkers] = useState(0);
  const [busy, setBusy] = useState(false);
  const startCount = useRef<number | null>(null);
  const samples = useRef<{ t: number; q: number }[]>([]);

  const poll = useCallback(async () => {
    try {
      const next = await VehicleTracker.getSyncStatus();
      if (startCount.current === null || next.queued > startCount.current || next.queued === 0) startCount.current = next.queued;
      const now = Date.now();
      samples.current = [...samples.current.filter((x) => now - x.t < 30_000), { t: now, q: next.queued }];
      setSt(next);
    } catch { /* next poll */ }
    setMarkers(pendingMarkerCount());
  }, []);

  // Only while the tab is on screen.
  useFocusEffect(useCallback(() => {
    void poll();
    const id = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(id);
  }, [poll]));

  const syncNow = async () => {
    setBusy(true);
    try {
      await VehicleTracker.syncNow().catch(() => {});
      if (token && pendingMarkerCount() > 0) await flushMarkerQueue(token).catch(() => {});
      await poll();
    } finally {
      setBusy(false);
    }
  };

  const rate = (() => {
    const xs = samples.current;
    if (xs.length < 2) return null;
    const a = xs[0];
    const b = xs[xs.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt >= 4 && a.q > b.q ? (a.q - b.q) / dt : null;
  })();

  const queued = st?.queued ?? 0;
  const nothingLeft = !!st && queued === 0 && markers === 0;
  const total = Math.max(startCount.current ?? 0, queued);
  const progress = total > 0 ? (total - queued) / total : 0;

  let tone: 'work' | 'warn' | 'bad' | 'ok' = 'work';
  let icon: React.ComponentProps<typeof FontAwesome>['name'] = 'cloud-upload';
  let title = '';
  let body = '';
  if (!st) {
    title = 'Checking…';
  } else if (nothingLeft) {
    tone = 'ok'; icon = 'check-circle';
    title = 'Everything is synced';
    body = st.tripOpen
      ? 'A trip is in progress — its points upload by themselves as you drive.'
      : 'All your trips and markers are saved on the server.';
  } else if (!st.online) {
    tone = 'warn'; icon = 'wifi';
    title = 'No internet connection';
    body = 'Nothing is lost — it is saved on this phone and uploads as soon as you have mobile data or Wi-Fi.';
  } else if (st.problem === 'auth') {
    tone = 'bad'; icon = 'lock';
    title = 'Your login has expired';
    body = 'Nothing is lost — it is saved on this phone. Sign out and sign in again, and it will upload.';
  } else if (st.problem === 'server' || st.problem === 'network') {
    tone = 'warn'; icon = 'refresh';
    title = 'The server is not answering right now';
    body = 'Nothing is lost — it is saved on this phone. We keep trying every few seconds.';
  } else {
    title = queued > 0 ? 'Syncing your trips' : 'Syncing your markers';
    body = st.tripOpen
      ? 'A trip is in progress — its points upload as you drive.'
      : 'Keep the app open and stay connected until this says everything is synced.';
  }
  const toneColor = { work: C.brand, warn: C.amber, bad: C.red, ok: C.green }[tone];
  const toneBg = { work: C.brandSoft, warn: C.amberBg, bad: C.redBg, ok: C.greenBg }[tone];
  const timeLeft = st && queued > 0 && st.online && !st.problem ? timeLeftText(st, rate) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 14 }]}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => { void syncNow(); }} tintColor={C.brand} />}
    >
      <Text style={s.heading}>Sync</Text>
      <Text style={s.lead}>Your trips upload by themselves. This shows anything still on this phone.</Text>

      <View style={s.card}>
        <View style={[s.iconWrap, { backgroundColor: toneBg }]}>
          {!st ? <ActivityIndicator color={C.brand} /> : <FontAwesome name={icon} size={30} color={toneColor} />}
        </View>
        <Text style={s.title}>{title}</Text>
        {!!body && <Text style={s.body}>{body}</Text>}
        {queued > 0 && (
          <>
            <Text style={[s.count, { color: toneColor }]}>{plural(queued, 'trip point', 'trip points')} left</Text>
            <View style={s.track}>
              <View style={[s.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: toneColor }]} />
            </View>
            {(timeLeft || st?.uploading) && (
              <View style={s.etaRow}>
                {st?.uploading && <ActivityIndicator size="small" color={C.brand} />}
                <Text style={s.eta}>{timeLeft ?? 'Uploading…'}</Text>
              </View>
            )}
          </>
        )}
      </View>

      <View style={s.list}>
        <Row icon="road" label="Trip points" value={queued ? `${queued.toLocaleString()} waiting` : 'All synced'} ok={!queued} />
        <Row icon="map-marker" label="Markers" value={markers ? `${markers} waiting` : 'All synced'} ok={!markers} />
        <Row icon="signal" label="Connection" value={st ? (st.online ? 'Online' : 'Offline') : '—'} ok={!!st?.online} />
        <Row icon="clock-o" label="Last upload" value={st?.lastSuccessAt ? ago(st.lastSuccessAt) : 'Not since the app opened'} ok last />
      </View>

      {st?.problem !== 'auth' && (
        <TouchableOpacity style={[s.primary, busy && { opacity: 0.6 }]} onPress={() => { void syncNow(); }} disabled={busy} accessibilityLabel="Sync now">
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>{nothingLeft ? 'Check again' : 'Sync now'}</Text>}
        </TouchableOpacity>
      )}

      <View style={s.note}>
        <FontAwesome name="shield" size={14} color={C.muted} />
        <Text style={s.noteText}>
          Before you uninstall the app, change phones or hand this phone to someone else, open this tab and wait until it
          says everything is synced — anything still on the phone is not on the server yet.
        </Text>
      </View>
    </ScrollView>
  );
}

function Row({ icon, label, value, ok, last }: {
  icon: React.ComponentProps<typeof FontAwesome>['name']; label: string; value: string; ok: boolean; last?: boolean;
}) {
  return (
    <View style={[s.row, last && { borderBottomWidth: 0 }]}>
      <FontAwesome name={icon} size={15} color={C.muted} style={{ width: 20, textAlign: 'center' }} />
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, { color: ok ? C.text : C.amber }]}>{value}</Text>
    </View>
  );
}

const shadow = { shadowColor: '#0f172a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 } as const;
const s = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingBottom: 28, gap: 12 },
  heading: { fontSize: 24, fontWeight: '800', color: C.text, letterSpacing: -0.4 },
  lead: { fontSize: 13.5, color: C.muted, marginTop: -6, lineHeight: 19 },
  card: { ...shadow, backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center' },
  iconWrap: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 19, fontWeight: '800', color: C.text, textAlign: 'center' },
  body: { fontSize: 14, color: C.text2, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  count: { fontSize: 24, fontWeight: '800', marginTop: 16, letterSpacing: -0.5 },
  track: { alignSelf: 'stretch', height: 8, borderRadius: 99, backgroundColor: '#eef1f6', marginTop: 12, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 99 },
  etaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  eta: { fontSize: 14, fontWeight: '700', color: C.text2 },
  list: { ...shadow, backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, paddingHorizontal: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.border },
  rowLabel: { flex: 1, fontSize: 14, color: C.text2 },
  rowValue: { fontSize: 14, fontWeight: '700' },
  primary: { backgroundColor: C.brand, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  primaryText: { color: '#ffffff', fontSize: 15.5, fontWeight: '800' },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingHorizontal: 4 },
  noteText: { flex: 1, fontSize: 12.5, color: C.muted, lineHeight: 18 },
});
