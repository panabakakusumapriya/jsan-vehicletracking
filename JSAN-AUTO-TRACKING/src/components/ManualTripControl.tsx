import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import * as VehicleTracker from '@/modules/vehicle-tracker';
import { useAuth } from '@/src/lib/auth';
import { getPermissionHealth } from '@/src/lib/permissions';

/**
 * Start trip / Stop trip, for projects set to manual recording (Project.tripMode = 'manual').
 *
 * On those projects the engine never starts or ends a trip by itself; this button is the only way
 * in and out, and everything between the two presses is recorded, walking included. It lives on
 * Home (inside the status card) and on the map (a pill at the top left), because a project may hide
 * either tab.
 *
 * The engine owns the trip state; this only asks and then reads the answer back (events, plus a
 * light status poll — a trip can also end by sign-out or the 8 h roll-over, and a heartbeat can
 * switch the mode while the screen is open).
 */
export type ManualTrip = {
  /** Show the controls: the project is manual, or the open trip was started by hand. */
  shown: boolean;
  tripOpen: boolean;
  /** When the open trip started (epoch ms), for the elapsed clock; null when unknown. */
  startedAt: number | null;
  busy: boolean;
  start: () => void;
  stop: () => void;
};

export function useManualTrip(): ManualTrip {
  const { user } = useAuth();
  const [status, setStatus] = useState<VehicleTracker.TrackerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const st = await VehicleTracker.getStatus();
      if (mounted.current) setStatus(st);
      return st;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(refresh, 5000);
    const subs = [
      VehicleTracker.addTripStartListener((e) => { setStartedAt(Date.parse(e.recordedAt) || Date.now()); void refresh(); }),
      VehicleTracker.addTripEndListener(() => { setStartedAt(null); void refresh(); }),
      VehicleTracker.addStateListener(() => { void refresh(); }),
    ].filter(Boolean);
    return () => {
      mounted.current = false;
      clearInterval(id);
      subs.forEach((s) => s?.remove());
    };
  }, [refresh]);

  // The engine's own mode wins (the heartbeat can change it while the app is open); the account's
  // is the fallback for the first moments, before the first status read.
  const mode = status?.tripMode ?? user?.tripMode ?? 'auto';
  const tripOpen = Boolean(status?.currentTripId);
  const shown =
    VehicleTracker.supportsManualTrips &&
    user?.role === 'user' &&
    (mode === 'manual' || Boolean(status?.tripManual));

  /** Wait (briefly) for the engine to report the trip opened or closed. */
  const settle = useCallback(async (wantOpen: boolean) => {
    for (let i = 0; i < 10; i += 1) {
      const st = await refresh();
      if (st && Boolean(st.currentTripId) === wantOpen) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }, [refresh]);

  const start = useCallback(() => {
    if (busy) return;
    void (async () => {
      setBusy(true);
      try {
        const perm = await getPermissionHealth().catch(() => null);
        if (perm && perm.fineLocation !== 'granted') {
          Alert.alert('Location is off for this app', 'Allow location access so your trip can be recorded, then press Start trip again.');
          return;
        }
        await VehicleTracker.startTrip();
        if (await settle(true)) setStartedAt(Date.now());
        else Alert.alert('Trip did not start', 'Check that Location is on, then press Start trip again.');
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [busy, settle]);

  const stop = useCallback(() => {
    if (busy) return;
    Alert.alert(
      'Stop this trip?',
      'Everything up to now is saved. Nothing more is recorded until you press Start trip again.',
      [
        { text: 'Keep recording', style: 'cancel' },
        {
          text: 'Stop trip',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await VehicleTracker.stopTrip();
                await settle(false);
                setStartedAt(null);
              } finally {
                if (mounted.current) setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [busy, settle]);

  return { shown, tripOpen, startedAt: tripOpen ? startedAt : null, busy, start, stop };
}

function useElapsed(startedAt: number | null): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** The big button for the Home status card (white on the card's colour). */
export function ManualTripButton({ trip }: { trip: ManualTrip }) {
  const elapsed = useElapsed(trip.startedAt);
  if (!trip.shown) return null;
  return (
    <TouchableOpacity
      style={[s.big, trip.tripOpen ? s.bigStop : s.bigStart]}
      onPress={trip.tripOpen ? trip.stop : trip.start}
      disabled={trip.busy}
      accessibilityRole="button"
      accessibilityLabel={trip.tripOpen ? 'Stop trip' : 'Start trip'}
    >
      {trip.busy ? (
        <ActivityIndicator color={trip.tripOpen ? '#dc2626' : '#059669'} />
      ) : (
        <>
          <FontAwesome name={trip.tripOpen ? 'stop' : 'play'} size={15} color={trip.tripOpen ? '#dc2626' : '#059669'} />
          <Text style={[s.bigText, { color: trip.tripOpen ? '#dc2626' : '#059669' }]}>
            {trip.tripOpen ? `Stop trip${elapsed ? ` · ${elapsed}` : ''}` : 'Start trip'}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

/** The compact pill for the map screen. */
export function ManualTripPill({ trip, style }: { trip: ManualTrip; style?: object }) {
  const elapsed = useElapsed(trip.startedAt);
  if (!trip.shown) return null;
  return (
    <View style={[s.pillWrap, style]} pointerEvents="box-none">
      <TouchableOpacity
        style={[s.pill, { backgroundColor: trip.tripOpen ? '#dc2626' : '#059669' }]}
        onPress={trip.tripOpen ? trip.stop : trip.start}
        disabled={trip.busy}
        accessibilityRole="button"
        accessibilityLabel={trip.tripOpen ? 'Stop trip' : 'Start trip'}
      >
        {trip.busy ? (
          <ActivityIndicator color="#ffffff" size="small" />
        ) : (
          <>
            <FontAwesome name={trip.tripOpen ? 'stop' : 'play'} size={12} color="#ffffff" />
            <Text style={s.pillText}>{trip.tripOpen ? `Stop trip${elapsed ? ` · ${elapsed}` : ''}` : 'Start trip'}</Text>
          </>
        )}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  big: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: '#ffffff', borderRadius: 14, paddingVertical: 14, marginTop: 4,
  },
  bigStart: {},
  bigStop: {},
  bigText: { fontSize: 16, fontWeight: '900', letterSpacing: 0.2 },
  pillWrap: { position: 'absolute', left: 12 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22, minWidth: 120, justifyContent: 'center',
    shadowColor: '#0f172a', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6,
  },
  pillText: { color: '#ffffff', fontSize: 14, fontWeight: '800' },
});
