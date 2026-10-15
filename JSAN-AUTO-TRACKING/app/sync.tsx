import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import type { SyncStatus } from '@/modules/vehicle-tracker';
import { useAuth } from '@/src/lib/auth';
import { allUploaded, setSigningOut, timeLeftText } from '@/src/lib/tripSync';

/**
 * The Sync screen: shown when a driver signs out while trip points are still on the phone.
 *
 * The trip has already been ended (Home's Sign out did that). This screen keeps uploading what is
 * left, says plainly how much and roughly how long, explains what is wrong when it cannot upload,
 * and signs the driver out by itself the moment everything is on the server.
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

const POLL_MS = 1_000;
const NUDGE_MS = 3_000;
/** The trip-end call may not have been answered by an older app build: do not wait on it forever. */
const TRIP_END_GRACE_MS = 6_000;

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function SyncScreen() {
  const insets = useSafeAreaInsets();
  const { signOut } = useAuth();
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [finishing, setFinishing] = useState(false);
  const startCount = useRef<number | null>(null);
  const samples = useRef<{ t: number; q: number }[]>([]);
  const openedAt = useRef(Date.now());
  const lastNudge = useRef(0);
  const doneRef = useRef(false);

  const finish = useCallback(async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setFinishing(true);
    await signOut();
    setSigningOut(false);
    router.replace('/login');
  }, [signOut]);

  // Poll, nudge the uploader when it sits idle with points waiting, and finish when it is all up.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let next: SyncStatus;
      try { next = await VehicleTracker.getSyncStatus(); } catch { return; }
      if (!alive) return;
      if (startCount.current === null || next.queued > startCount.current) startCount.current = next.queued;
      const now = Date.now();
      samples.current = [...samples.current.filter((x) => now - x.t < 30_000), { t: now, q: next.queued }];
      setSt(next);
      const tripEndedOrGaveUp = !next.tripOpen || now - openedAt.current > TRIP_END_GRACE_MS;
      if (next.queued === 0 && tripEndedOrGaveUp) {
        setTimeout(() => { void finish(); }, 1_200); // let "all uploaded" be seen
        return;
      }
      if (next.online && !next.uploading && next.queued > 0 && now - lastNudge.current > NUDGE_MS) {
        lastNudge.current = now;
        VehicleTracker.flushNow().catch(() => {});
      }
    };
    void tick();
    const id = setInterval(() => { void tick(); }, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [finish]);

  /** Back to work: tracking starts again; the ended trip stays ended and the next drive is a new one. */
  const stay = useCallback(() => {
    setSigningOut(false);
    VehicleTracker.start().catch(() => {});
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home' as any);
  }, []);

  // Android's back button means "stay", never a half-finished sign-out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { stay(); return true; });
    return () => sub.remove();
  }, [stay]);

  const retry = () => {
    lastNudge.current = Date.now();
    VehicleTracker.flushNow().catch(() => {});
  };

  const signOutAnyway = () => {
    const n = st?.queued ?? 0;
    Alert.alert(
      'Sign out without uploading?',
      `${plural(n, 'trip point', 'trip points')} will stay saved on this phone. They upload the next time you sign in on this phone — until then this driving will not show in your trips.`,
      [
        { text: 'Keep uploading', style: 'cancel' },
        { text: 'Sign out anyway', style: 'destructive', onPress: () => { void finish(); } },
      ],
    );
  };

  // How fast the count has really been falling over the last half minute.
  const rate = (() => {
    const xs = samples.current;
    if (xs.length < 2) return null;
    const a = xs[0];
    const b = xs[xs.length - 1];
    const dt = (b.t - a.t) / 1000;
    return dt >= 4 && a.q > b.q ? (a.q - b.q) / dt : null;
  })();

  const done = !!st && (allUploaded(st) || (st.queued === 0 && Date.now() - openedAt.current > TRIP_END_GRACE_MS));
  const total = Math.max(startCount.current ?? 0, st?.queued ?? 0);
  const progress = total > 0 && st ? (total - st.queued) / total : 0;

  let tone: 'work' | 'warn' | 'bad' | 'ok' = 'work';
  let icon: React.ComponentProps<typeof FontAwesome>['name'] = 'cloud-upload';
  let title = 'Your trip points are still being uploaded';
  let body = 'Keep the app open and stay connected. You will be signed out as soon as everything is uploaded.';
  if (!st) {
    title = 'Checking your trips…';
    body = '';
  } else if (done) {
    tone = 'ok'; icon = 'check-circle';
    title = 'All your trips are uploaded';
    body = 'Signing you out…';
  } else if (!st.online) {
    tone = 'warn'; icon = 'wifi';
    title = 'No internet connection';
    body = 'Your trip points are saved safely on this phone. They will upload as soon as you are connected — turn on mobile data or connect to Wi-Fi.';
  } else if (st.problem === 'auth') {
    tone = 'bad'; icon = 'lock';
    title = 'Your login has expired';
    body = 'Your trip points are saved safely on this phone. Sign in again on this phone and they will upload.';
  } else if (st.problem === 'server' || st.problem === 'network') {
    tone = 'warn'; icon = 'refresh';
    title = 'The server is not answering right now';
    body = 'Your trip points are saved safely on this phone. We keep trying every few seconds.';
  }
  const timeLeft = st && !done && st.online && !st.problem ? (timeLeftText(st, rate) ?? 'Working out how long it will take…') : null;
  const toneColor = { work: C.brand, warn: C.amber, bad: C.red, ok: C.green }[tone];
  const toneBg = { work: C.brandSoft, warn: C.amberBg, bad: C.redBg, ok: C.greenBg }[tone];

  return (
    <View style={[s.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.heading}>Uploading your trips</Text>

        <View style={s.card}>
          <View style={[s.iconWrap, { backgroundColor: toneBg }]}>
            {!st ? <ActivityIndicator color={C.brand} /> : <FontAwesome name={icon} size={30} color={toneColor} />}
          </View>
          <Text style={s.title}>{title}</Text>
          {!!body && <Text style={s.body}>{body}</Text>}

          {st && st.queued > 0 && (
            <>
              <Text style={[s.count, { color: toneColor }]}>{plural(st.queued, 'trip point', 'trip points')} left</Text>
              <View style={s.track}>
                <View style={[s.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: toneColor }]} />
              </View>
              {timeLeft && (
                <View style={s.etaRow}>
                  {st.uploading && <ActivityIndicator size="small" color={C.brand} />}
                  <Text style={s.eta}>{timeLeft}</Text>
                </View>
              )}
            </>
          )}
          {done && <ActivityIndicator style={{ marginTop: 14 }} color={C.green} />}
        </View>

        {!done && (
          <View style={s.note}>
            <FontAwesome name="shield" size={14} color={C.muted} />
            <Text style={s.noteText}>Your trip has been ended. Nothing is lost — the points stay on this phone until they reach the server.</Text>
          </View>
        )}
      </ScrollView>

      {!done && !finishing && (
        <View style={s.actions}>
          {st && st.queued > 0 && st.problem !== 'auth' && (
            <TouchableOpacity style={s.primary} onPress={retry} accessibilityLabel="Try uploading again now">
              <Text style={s.primaryText}>Try again now</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.secondary} onPress={stay} accessibilityLabel="Stay signed in">
            <Text style={s.secondaryText}>Stay signed in</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.link} onPress={st?.problem === 'auth' ? () => { void finish(); } : signOutAnyway}>
            <Text style={s.linkText}>{st?.problem === 'auth' ? 'Sign out and sign in again' : 'Sign out anyway'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 18 },
  content: { paddingBottom: 12 },
  heading: { fontSize: 13, fontWeight: '800', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 },
  card: { backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 22, alignItems: 'center' },
  iconWrap: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 19, fontWeight: '800', color: C.text, textAlign: 'center' },
  body: { fontSize: 14.5, color: C.text2, textAlign: 'center', marginTop: 8, lineHeight: 21 },
  count: { fontSize: 26, fontWeight: '800', marginTop: 18, letterSpacing: -0.5 },
  track: { alignSelf: 'stretch', height: 8, borderRadius: 99, backgroundColor: '#eef1f6', marginTop: 12, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 99 },
  etaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  eta: { fontSize: 14, fontWeight: '700', color: C.text2 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 14, paddingHorizontal: 4 },
  noteText: { flex: 1, fontSize: 12.5, color: C.muted, lineHeight: 18 },
  actions: { gap: 10 },
  primary: { backgroundColor: C.brand, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  primaryText: { color: '#ffffff', fontSize: 15.5, fontWeight: '800' },
  secondary: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, paddingVertical: 14, alignItems: 'center' },
  secondaryText: { color: C.text, fontSize: 15, fontWeight: '700' },
  link: { paddingVertical: 8, alignItems: 'center' },
  linkText: { color: C.red, fontSize: 13.5, fontWeight: '700' },
});
