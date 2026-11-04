import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { AcademyCard } from '@/src/components/AcademyCard';
import { DayWork } from '@/src/components/DayWork';
import { TrackingChecklist } from '@/src/components/TrackingChecklist';
import { loadProgress } from '@/src/lib/academy';
import { API_BASE_URL } from '@/src/lib/config';
import { useAuth } from '@/src/lib/auth';
import { ensurePermissions } from '@/src/lib/permissions';
import { setSigningOut, uploadWhatIsLeft } from '@/src/lib/tripSync';
import { deviceTimezone } from '@/src/lib/timezone';

type UiState = 'starting' | 'idle' | 'tracking' | 'blocked' | 'night';
type UploadError = { reason: string; message: string; code?: number } | null;

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

/** The hero card: one colour per state, white text on it. */
const STATE = {
  tracking: { label: 'Trip in progress',    sub: 'Your drive is being recorded.',                     bg: '#059669', icon: 'road' },
  blocked:  { label: 'Action needed',       sub: '',                                                  bg: '#dc2626', icon: 'exclamation-triangle' },
  starting: { label: 'Getting ready…',      sub: 'Setting up background tracking.',                   bg: '#d97706', icon: 'hourglass-half' },
  idle:     { label: 'Ready to drive',      sub: 'Tracking starts by itself as soon as you move.',    bg: C.brand,   icon: 'check-circle' },
  night:    { label: 'Waiting for movement', sub: 'Tracking starts by itself as soon as you drive.',  bg: '#475569', icon: 'moon-o' },
} as const;

function greetingNow(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Home() {
  const { user, token, signOut } = useAuth();
  const [uiState, setUiState] = useState<UiState>('starting');
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<VehicleTracker.TrackerStatus | null>(null);
  const [lastFix, setLastFix] = useState<VehicleTracker.LocationEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadError, setUploadError] = useState<UploadError>(null);
  /** Bumped when a trip starts or ends, or on pull-to-refresh: the working-hours card reloads. */
  const [workKey, setWorkKey] = useState(0);
  const started = useRef(false);
  /** `${token}|${driverId}` last handed to the native service — dedupes configure() calls. */
  const lastConfiguredRef = useRef<string | null>(null);
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
    try {
      // Daylight still decides the night state (tracking paused); it is just not shown as a card.
      const dl = await VehicleTracker.getDaylightInfo();
      if (dl.isDaylight === false && uiState !== 'starting' && uiState !== 'blocked') {
        setUiState('night');
      } else if (dl.isDaylight === true && uiState === 'night') {
        setUiState('idle');
      }
    } catch {}
  }, [uiState]);

  useEffect(() => {
    if (started.current || !user || !token) return;
    started.current = true;
    // Primed synchronously, so the token-follow effect below is a no-op on first mount — this
    // effect owns the first configure() (and its API_BASE_URL guard runs first).
    lastConfiguredRef.current = `${token}|${user._id}`;
    (async () => {
      if (!VehicleTracker.isSupported) {
        setUiState('idle');
        // Distinguishes "wrong platform" from "right platform, module missing from this build".
        setPermMsg(VehicleTracker.unavailableReason ?? 'Background tracking is unavailable.');
        return;
      }
      const perm = await ensurePermissions();
      if (!perm.ok) { setUiState('blocked'); setPermMsg(perm.message ?? 'Permissions required.'); return; }

      // Guard: never pass empty/falsy values to native — service would start with broken config
      if (!API_BASE_URL || !token || !user._id) {
        setUiState('blocked');
        setPermMsg('Configuration error — please sign out and sign in again.');
        return;
      }

      // Sunrise/sunset start-stop needs a zone before the first GPS point exists. Prefer the
      // server's coordinate-derived one; fall back to the device's rather than leaving the
      // schedule on whatever the native default happens to be.
      const tz = user.timezone ?? deviceTimezone();
      if (tz) {
        await VehicleTracker.setTimezone(tz);
      }

      await VehicleTracker.configure(API_BASE_URL, token, user._id);
      await VehicleTracker.start();
      // Battery optimisation is the #1 silent tracking killer: an "optimised" app has its
      // service culled minutes after the screen goes dark. Ask for the exemption up front —
      // one system dialog; a driver who declines still shows up in App Health, because the
      // heartbeats carry batteryRestricted.
      try {
        if (!(await VehicleTracker.isIgnoringBatteryOptimizations())) {
          await VehicleTracker.requestIgnoreBatteryOptimizations();
        }
      } catch { /* dialog unavailable — the heartbeat flag still reports the state */ }
      setUiState('idle');
      refreshStatus();
    })();
  }, [user, token, refreshStatus]);

  /**
   * The service's token must FOLLOW the app's, not freeze at first launch. `started` guards the
   * one-time startup above, which means a re-login while the process was alive used to leave the
   * native uploader holding the superseded token: the backend's single-session rule 401s it
   * forever, points pile up in device SQLite, and the driver's live map freezes at the last
   * uploaded fix while everything else looks healthy. configure() only rewrites the service's
   * stored config, so re-running it on every token change is cheap and safe.
   */
  useEffect(() => {
    // Same guard as the startup path: configure() persists whatever it is given, so an empty
    // API_BASE_URL here would clobber a previously valid stored config.
    if (!started.current || !API_BASE_URL || !token || !user?._id) return;
    const key = `${token}|${user._id}`;
    // Primed by the startup effect, so first mount does not configure twice; a refreshed user
    // object carrying the same token/id (timezone sync and the like) is a no-op too.
    if (lastConfiguredRef.current === key) return;
    lastConfiguredRef.current = key;
    VehicleTracker.configure(API_BASE_URL, token, user._id).catch(() => {});
  }, [user, token]);

  useEffect(() => {
    const subs = [
      VehicleTracker.addStateListener(e => { setUiState(e.state === 'tracking' ? 'tracking' : 'idle'); refreshStatus(); }),
      // Idle fixes (tripStatus 'idle') exist for the map dot only — they must not flip the home
      // card to "Trip in progress" while the vehicle is parked.
      VehicleTracker.addLocationListener(e => {
        // Deduped: identical parked fixes (idle emits every 5-10 s) must not re-render the screen.
        setLastFix(prev =>
          prev && prev.lat === e.lat && prev.lon === e.lon && prev.tripStatus === e.tripStatus
            ? prev : e);
        if (e.tripStatus === 'active') setUiState('tracking');
      }),
      VehicleTracker.addTripEndListener(() => { setUiState('idle'); refreshStatus(); setWorkKey(k => k + 1); }),
      VehicleTracker.addUploadErrorListener(e => { setUploadError(e); }),
    ].filter(Boolean);
    return () => subs.forEach(s => s?.remove());
  }, [refreshStatus]);

  // A trip starting shows up as a running row straight away (once the server has its first points).
  useEffect(() => {
    if (uiState !== 'tracking') return;
    const t = setTimeout(() => setWorkKey(k => k + 1), 20_000);
    return () => clearTimeout(t);
  }, [uiState]);

  // Upload failures re-fire on every failed flush (~10-30 s), each replacing the event object and
  // re-arming this timer — the banner stays up while failures continue and clears itself 90 s
  // after the last one. The old rule (clear on the next recorded trip point) left a stale
  // "re-login" banner up all night whenever the queue recovered while the vehicle was parked.
  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(null), 90_000);
    return () => clearTimeout(t);
  }, [uploadError]);

  useEffect(() => { const id = setInterval(refreshStatus, 4000); return () => clearInterval(id); }, [refreshStatus]);

  const onRefresh = async () => {
    setRefreshing(true);
    await VehicleTracker.flushNow();
    await refreshStatus();
    setWorkKey(k => k + 1);
    setRefreshing(false);
  };

  /**
   * Sign out: end the trip FIRST — a trip left open was resumed by the next sign-in and that day's
   * driving filed under the previous one — then upload what the phone still holds. Done in a few
   * seconds: signed out straight away. Not done: the Sync screen takes over and shows the driver
   * what is left, and signs them out itself when everything is up.
   */
  const [signingOutUi, setSigningOutUi] = useState(false);
  /**
   * Ask first. Drivers were signing out for a lunch break and only signing back in after they had
   * already set off again, so the first stretch of the afternoon was never recorded (Vincentius
   * Geraldo, 15 Oct 2026: 3.4 km). Nothing records while signed out; say so before it happens.
   */
  const confirmSignOut = () => {
    if (signingOutUi) return;
    Alert.alert(
      'Sign out?',
      'While you are signed out, your driving is not recorded. Sign in again before you start driving.',
      [
        { text: 'Stay signed in', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => { void startSignOut(); } },
      ],
    );
  };

  const startSignOut = async () => {
    if (signingOutUi) return;
    setSigningOutUi(true);
    setSigningOut(true);
    try {
      await VehicleTracker.endTripAndStop().catch(() => {});
      const st = await uploadWhatIsLeft(4_000);
      if (st.queued === 0) {
        await signOut();
        setSigningOut(false);
        router.replace('/login');
      } else {
        router.push('/sync' as any);
      }
    } catch {
      // Something failed part-way (the trip may already be ended). Back to normal: tracking on
      // again — the next drive is a new trip — and the driver can simply try again.
      setSigningOut(false);
      VehicleTracker.start().catch(() => {});
      Alert.alert('Could not sign out', 'Something went wrong while saving your trip. You are still signed in — please try again.');
    } finally {
      setSigningOutUi(false);
    }
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

  const insets = useSafeAreaInsets();
  const cfg = STATE[uiState];
  const subText = uiState === 'blocked' ? (permMsg ?? '') : cfg.sub;
  const firstName = user?.name?.split(' ')[0] ?? 'Driver';
  const initials = (user?.name ?? 'D').split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const queued = status?.queued ?? 0;
  const speed = uiState === 'tracking' && lastFix ? `${Math.round(lastFix.speedKmh)} km/h` : '—';
  // Until the course is finished it sits near the top; after, it is a way back in, at the bottom.
  const academyDone = Boolean(loadProgress(user).completedAt);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
    <ScrollView
      style={s.root}
      contentContainerStyle={[s.content, { paddingTop: insets.top + 14 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
    >
      {/* ── Header: who, and today ── */}
      <View style={s.header}>
        <View style={s.avatar}>
          <Text style={s.avatarText}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.greeting} numberOfLines={1}>{greetingNow()}, {firstName}</Text>
          <Text style={s.date}>{today}</Text>
        </View>
        {/* Project-level permission. `!== false` on purpose: a driver whose project predates
            the setting, or whose session was restored from storage before the server answered,
            must keep the button. Hiding it on a missing value would strand drivers signed in on
            a shared handset with no way to hand it over. */}
        {user?.showLogout !== false && (
          <TouchableOpacity style={s.signOutBtn} onPress={confirmSignOut} disabled={signingOutUi} accessibilityLabel="Sign out">
            <FontAwesome name="sign-out" size={15} color={C.text2} />
            <Text style={s.signOutText}>{signingOutUi ? 'Signing out…' : 'Sign out'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Upload error banner ── */}
      {uploadError && (
        <View style={s.uploadErrBanner}>
          <FontAwesome name="exclamation-circle" size={16} color={C.amber} />
          <Text style={s.uploadErrText}>
            {uploadError.reason === 'auth_failure'
              ? 'Sign-in expired — sign out and back in so your trips upload again.'
              : 'Uploads paused — open the app to sign in again.'}
          </Text>
          <TouchableOpacity onPress={() => setUploadError(null)} hitSlop={10} accessibilityLabel="Dismiss">
            <Text style={s.uploadErrDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Hero: what the app is doing right now ── */}
      <View style={[s.hero, { backgroundColor: cfg.bg }]}>
        <View style={s.heroTop}>
          <View style={s.dotArea}>
            <Animated.View style={[s.dotRing, { transform: [{ scale: pulseAnim }] }]} />
            <View style={s.dot} />
          </View>
          <Text style={s.heroLabel}>{cfg.label}</Text>
          <FontAwesome name={cfg.icon} size={20} color="rgba(255,255,255,0.85)" style={{ marginLeft: 'auto' }} />
        </View>
        {subText ? <Text style={s.heroSub}>{subText}</Text> : null}
        {uiState === 'blocked' ? (
          <TouchableOpacity style={s.permBtn} onPress={retryPermissions}>
            <Text style={[s.permBtnText, { color: cfg.bg }]}>Grant permissions</Text>
          </TouchableOpacity>
        ) : uiState !== 'starting' ? (
          <View style={s.heroChips}>
            <HeroChip icon="tachometer" label="Speed" value={speed} />
            <HeroChip icon={queued ? 'cloud-upload' : 'check'} label="Uploads" value={queued ? `${queued} waiting` : 'All sent'} />
          </View>
        ) : null}
      </View>

      {!academyDone && <AcademyCard />}

      {/* ── Today: working hours (compact; the whole day opens in a sheet) ── */}
      <Text style={s.section}>Today</Text>
      <DayWork token={token} refreshKey={workKey} />

      {/* ── The phone: the same switches the login gate enforces, kept in sight so a revoked
             permission, an OEM re-enabling battery limits or GPS toggled off is seen, not suffered. ── */}
      <Text style={s.section}>Your phone</Text>
      <TrackingChecklist compact />

      {academyDone && (
        <>
          <Text style={s.section}>Help</Text>
          <AcademyCard />
        </>
      )}

      {/* For support on the phone: who is signed in, and where the GPS last put the phone. */}
      <Text style={s.footer}>
        {user?.email}
        {lastFix ? `  ·  GPS ${lastFix.lat.toFixed(4)}, ${lastFix.lon.toFixed(4)}` : ''}
        {`  ·  ${queued} point${queued === 1 ? '' : 's'} waiting`}
      </Text>
    </ScrollView>
    </View>
  );
}

/* ── Sub-components ── */
function HeroChip({ icon, label, value }: { icon: React.ComponentProps<typeof FontAwesome>['name']; label: string; value: string }) {
  return (
    <View style={s.chip}>
      <FontAwesome name={icon} size={14} color="#ffffff" />
      <View>
        <Text style={s.chipLabel}>{label}</Text>
        <Text style={s.chipValue}>{value}</Text>
      </View>
    </View>
  );
}


/* ── Styles ── */
const card = {
  backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border,
  shadowColor: '#0f172a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
} as const;

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: 18, paddingBottom: 28, gap: 12 },

  header:     { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 2 },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center',
    shadowColor: C.brandDeep, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  avatarText:  { color: '#fff', fontSize: 16, fontWeight: '900' },
  greeting:    { color: C.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  date:        { color: C.muted, fontSize: 12.5, marginTop: 2 },
  signOutBtn:  {
    ...card, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
  },
  signOutText: { color: C.text2, fontSize: 12.5, fontWeight: '700' },

  hero: {
    borderRadius: 22, padding: 18, gap: 10,
    shadowColor: '#0f172a', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 14, elevation: 6,
  },
  heroTop:   { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dotArea:   { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  dotRing:   { position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.35)' },
  dot:       { width: 11, height: 11, borderRadius: 6, backgroundColor: '#ffffff' },
  heroLabel: { color: '#ffffff', fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  heroSub:   { color: 'rgba(255,255,255,0.88)', fontSize: 13.5, lineHeight: 19 },
  heroChips: { flexDirection: 'row', gap: 10, marginTop: 4 },
  chip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10,
  },
  chipLabel: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  chipValue: { color: '#ffffff', fontSize: 15, fontWeight: '800', marginTop: 1 },
  permBtn:     { backgroundColor: '#ffffff', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 2 },
  permBtnText: { fontSize: 14, fontWeight: '800' },

  section: {
    color: C.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 8, marginBottom: -4, marginLeft: 4,
  },
  footer: { color: C.muted, fontSize: 11.5, textAlign: 'center', marginTop: 10, lineHeight: 17 },

  uploadErrBanner: {
    backgroundColor: C.amberBg, borderRadius: 14, borderWidth: 1, borderColor: C.amberBd,
    paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  uploadErrText: { flex: 1, fontSize: 13, color: '#92400e', fontWeight: '600', lineHeight: 18 },
  uploadErrDismiss: { fontSize: 14, color: C.muted, fontWeight: '700', paddingHorizontal: 4 },
});
