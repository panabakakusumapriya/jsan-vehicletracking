import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { apiMyDay, type MyDay } from '@/src/lib/api';
import { deviceTimezone } from '@/src/lib/timezone';

/**
 * "Today's work": the driver's trips on one day, start – end and how long each ran, with the day's
 * total working hours as the last row. ‹ › step back through earlier days.
 *
 * Working hours are every trip's start to end added up — the time parked between trips is not
 * counted, the same figure the admin panel's Trips page shows for that driver-day. A trip still
 * running keeps counting on screen.
 */

const C = {
  brand: '#7c3aed',
  surface: '#ffffff',
  border: '#e9ecf0',
  text: '#0d0d12',
  text2: '#374151',
  muted: '#9ca3af',
  green: '#059669',
  totalBg: '#f5f3ff',
};

const pad = (n: number) => String(n).padStart(2, '0');
/** The device's local calendar day, `offset` days back from today, as YYYY-MM-DD. */
function localDate(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const hm = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${pad(mins % 60)}m` : `${mins}m`;
};
const km = (m: number) => `${(m / 1000).toFixed(1)} km`;
function dayLabel(offset: number, date: string): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** How far back the arrows go — the same month a driver might be asked about. */
const MAX_DAYS_BACK = 31;

export function DayWork({ token, refreshKey }: { token: string | null; refreshKey: number }) {
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState<MyDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When `day` arrived — a running trip's duration grows from there. */
  const fetchedAt = useRef(Date.now());
  const [, setTick] = useState(0);
  const date = localDate(offset);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await apiMyDay(token, date, deviceTimezone());
      fetchedAt.current = Date.now();
      setDay(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your trips');
    } finally {
      setLoading(false);
    }
  }, [token, date]);

  // On open, on a day change, on pull-to-refresh and whenever a trip starts or ends (refreshKey).
  useEffect(() => { load(); }, [load, refreshKey]);

  const running = Boolean(day?.trips.some((t) => !t.endedAt));
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [running]);

  const extra = Date.now() - fetchedAt.current;
  const durationOf = (t: MyDay['trips'][number]) => t.durationMs + (t.endedAt ? 0 : extra);
  const shown = day && day.date === date ? day : null;
  const workMs = shown ? shown.trips.reduce((a, t) => a + durationOf(t), 0) : 0;

  return (
    <View style={s.card}>
      <View style={s.head}>
        <Text style={s.title}>Working hours</Text>
        <View style={s.nav}>
          <TouchableOpacity
            style={[s.arrow, offset >= MAX_DAYS_BACK && s.arrowOff]}
            disabled={offset >= MAX_DAYS_BACK}
            onPress={() => setOffset((o) => o + 1)}
            accessibilityLabel="Previous day"
          >
            <Text style={s.arrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={s.day}>{dayLabel(offset, date)}</Text>
          <TouchableOpacity
            style={[s.arrow, offset === 0 && s.arrowOff]}
            disabled={offset === 0}
            onPress={() => setOffset((o) => Math.max(0, o - 1))}
            accessibilityLabel="Next day"
          >
            <Text style={s.arrowText}>›</Text>
          </TouchableOpacity>
        </View>
      </View>

      {!shown ? (
        <View style={s.empty}>
          {loading ? <ActivityIndicator color={C.brand} /> : <Text style={s.muted}>{error ?? 'No trips yet.'}</Text>}
        </View>
      ) : (
        <>
          <View style={[s.row, s.colHead]}>
            <Text style={[s.cTime, s.headText]}>Start – End</Text>
            <Text style={[s.cDur, s.headText]}>Duration</Text>
            <Text style={[s.cKm, s.headText]}>Distance</Text>
          </View>
          {shown.trips.length === 0 && (
            <Text style={[s.muted, { paddingVertical: 10 }]}>No trips on this day.</Text>
          )}
          {shown.trips.map((t) => (
            <View key={t.id} style={s.row}>
              <Text style={s.cTime}>
                {clock(t.startedAt)} – {t.endedAt ? clock(t.endedAt) : <Text style={{ color: C.green, fontWeight: '700' }}>now</Text>}
              </Text>
              <Text style={s.cDur}>{hm(durationOf(t))}</Text>
              <Text style={s.cKm}>{km(t.distanceMeters)}</Text>
            </View>
          ))}
          <View style={[s.row, s.total]}>
            <Text style={[s.cTime, s.totalText]}>
              Total · {shown.trips.length} trip{shown.trips.length === 1 ? '' : 's'}
            </Text>
            <Text style={[s.cDur, s.totalText, { color: C.brand }]}>{hm(workMs)}</Text>
            <Text style={[s.cKm, s.totalText]}>{km(shown.totals.distanceMeters)}</Text>
          </View>
          {error && <Text style={[s.muted, { marginTop: 6 }]}>Showing the last loaded figures — {error}</Text>}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 12, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  arrow: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  arrowOff: { opacity: 0.35 },
  arrowText: { fontSize: 18, fontWeight: '700', color: C.text2, marginTop: -2 },
  day: { fontSize: 13, fontWeight: '700', color: C.text, minWidth: 92, textAlign: 'center' },
  empty: { paddingVertical: 16, alignItems: 'center' },
  muted: { color: C.muted, fontSize: 12.5 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.border },
  colHead: { borderTopWidth: 0, paddingTop: 0 },
  headText: { fontSize: 11, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.3 },
  cTime: { flex: 1.5, fontSize: 13.5, color: C.text, fontVariant: ['tabular-nums'] },
  cDur: { flex: 1, fontSize: 13.5, color: C.text, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  cKm: { flex: 1, fontSize: 13.5, color: C.text2, textAlign: 'right', fontVariant: ['tabular-nums'] },
  total: { backgroundColor: C.totalBg, borderRadius: 10, borderTopWidth: 0, marginTop: 4, paddingHorizontal: 8 },
  totalText: { fontWeight: '800', fontSize: 14 },
});
