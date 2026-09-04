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
import { deviceTimezone } from '@/src/lib/timezone';
import { TabBar } from '@/src/components/TabBar';

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

const STATE = {
  tracking: { label: 'Trip in progress',       sub: 'Your location is being recorded.',                              color: C.green, bg: C.greenBg, bd: C.greenBd },
  blocked:  { label: 'Action needed',           sub: '',                                                              color: C.red,   bg: C.redBg,   bd: C.redBd   },
  starting: { label: 'Starting…',              sub: 'Setting up background tracking.',                              color: C.amber, bg: C.amberBg, bd: C.amberBd },
  idle:     { label: 'Ready',                   sub: '',                                                             color: C.brand, bg: C.brandSoft, bd: '#d8b4fe' },
  night:    { label: 'Idle',                   sub: 'Waiting for movement — tracking runs at any hour.',            color: C.muted, bg: '#f1f5f9',   bd: C.border   },
};

export default function Home() {
  const { user, token, signOut } = useAuth();
  const [uiState, setUiState] = useState<UiState>('starting');
  const [permMsg, setPermMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<VehicleTracker.TrackerStatus | null>(null);
  const [lastFix, setLastFix] = useState<VehicleTracker.LocationEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadError, setUploadError] = useState<UploadError>(null);
  const [daylightInfo, setDaylightInfo] = useState<VehicleTracker.DaylightInfo | null>(null);
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
      const dl = await VehicleTracker.getDaylightInfo();
      setDaylightInfo(dl);
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
      VehicleTracker.addTripEndListener(() => { setUiState('idle'); refreshStatus(); }),
      VehicleTracker.addUploadErrorListener(e => { setUploadError(e); }),
    ].filter(Boolean);
    return () => subs.forEach(s => s?.remove());
  }, [refreshStatus]);

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
    <View style={{ flex: 1 }}>
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

      {/* ── Upload error banner ── */}
      {uploadError && (
        <View style={s.uploadErrBanner}>
          <Text style={s.uploadErrText}>
            {uploadError.reason === 'auth_failure'
              ? '⚠️ Auth expired — sign out and back in to resume uploads.'
              : '⚠️ Upload paused — open the app to re-authenticate.'}
          </Text>
          <TouchableOpacity onPress={() => setUploadError(null)}>
            <Text style={s.uploadErrDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

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

      {/* ── Daylight info ── */}
      {daylightInfo?.sunrise && daylightInfo?.sunset && (
        <View style={s.daylightCard}>
          <Text style={s.daylightTitle}>Daylight tracking</Text>
          <View style={s.daylightRow}>
            <Text style={s.daylightLabel}>Sunrise</Text>
            <Text style={s.daylightValue}>{daylightInfo.sunrise}</Text>
          </View>
          <View style={s.daylightRow}>
            <Text style={s.daylightLabel}>Sunset</Text>
            <Text style={s.daylightValue}>{daylightInfo.sunset}</Text>
          </View>
          <View style={s.daylightRow}>
            <Text style={s.daylightLabel}>Timezone</Text>
            <Text style={s.daylightValue}>{daylightInfo.timezoneId}</Text>
          </View>
        </View>
      )}

      {/* ── Stats grid ── */}
      <View style={s.grid}>
        <StatTile label="Speed"   value={lastFix ? `${Math.round(lastFix.speedKmh)}` : '—'} unit="km/h"  color={C.brand}   />
        <StatTile label="Queued"  value={String(status?.queued ?? 0)}                         unit="pts"   color="#7c3aed"   />
        <StatTile label="Lat"     value={lastFix ? lastFix.lat.toFixed(4) : '—'}              unit=""      color="#059669"   />
        <StatTile label="Lon"     value={lastFix ? lastFix.lon.toFixed(4) : '—'}              unit=""      color="#d97706"   />
      </View>

      {/* spacer */}
      <View style={{ paddingBottom: 20 }} />
    </ScrollView>
    <TabBar />
    </View>
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

  note: { color: C.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: 20 },
  uploadErrBanner: {
    backgroundColor: C.amberBg, borderRadius: 12, borderWidth: 1, borderColor: C.amberBd,
    paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  uploadErrText: { flex: 1, fontSize: 12.5, color: C.amber, fontWeight: '600', lineHeight: 17 },
  uploadErrDismiss: { fontSize: 14, color: C.muted, fontWeight: '700', paddingHorizontal: 4 },

  daylightCard: {
    backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border,
    padding: 14,
  },
  daylightTitle: { fontSize: 12, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 },
  daylightRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  daylightLabel: { fontSize: 13, color: C.text2 },
  daylightValue: { fontSize: 13, fontWeight: '700', color: C.text },
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

