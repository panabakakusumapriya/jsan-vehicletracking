import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/src/lib/auth';
import { API_BASE_URL } from '@/src/lib/config';
import { TabBar } from '@/src/components/TabBar';
import { LeafletMap } from '@/src/components/LeafletMap';

const C = {
  brand:    '#7c3aed',
  brandSoft:'#ede9fe',
  bg:       '#f7f7fb',
  surface:  '#ffffff',
  border:   '#e9ecf0',
  text:     '#0d0d12',
  muted:    '#9ca3af',
  green:    '#059669',
  greenBg:  '#ecfdf5',
};

interface Point { lat: number; lon: number; speedKmh: number; recordedAt: string }
interface Trip  { _id: string; status: string; startedAt: string; endedAt?: string | null; distanceMeters: number; maxSpeedKmh: number; pointCount: number }

function km(m: number) {
  if (!m) return '0 km';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function elapsed(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function MapScreen() {
  const { token } = useAuth();
  const [trip,    setTrip]    = useState<Trip | null>(null);
  const [points,  setPoints]  = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt]   = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSession = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res  = await fetch(`${API_BASE_URL}/api/tracking/my-session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data: { trip: Trip | null; points: Point[] } = await res.json();
      setTrip(data.trip);
      setPoints(data.points ?? []);
      setUpdatedAt(new Date());
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  }, [token]);

  useEffect(() => {
    fetchSession();
    timerRef.current = setInterval(() => fetchSession(true), 15_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchSession]);

  const onRefresh = () => { setRefreshing(true); fetchSession(true); };

  if (loading) {
    return (
      <View style={{ flex: 1 }}>
        <View style={s.center}>
          <ActivityIndicator color={C.brand} size="large" />
          <Text style={s.loadText}>Loading session…</Text>
        </View>
        <TabBar />
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={s.center}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.brand} />}
        >
          <View style={s.emptyCard}>
            <Text style={s.emptyEmoji}>🗺️</Text>
            <Text style={s.emptyTitle}>No trips found</Text>
            <Text style={s.emptyBody}>
              No trips in the last 7 days. Start driving — your route will appear here automatically once a trip begins.
            </Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => fetchSession()}>
              <Text style={s.retryText}>Check again</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
        <TabBar />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Stats bar */}
      <View style={s.statsBar}>
        <View style={s.stat}><Text style={s.statV}>{points.length}</Text><Text style={s.statK}>Points</Text></View>
        <View style={s.sep} />
        <View style={s.stat}><Text style={s.statV}>{km(trip.distanceMeters)}</Text><Text style={s.statK}>Distance</Text></View>
        <View style={s.sep} />
        <View style={s.stat}><Text style={s.statV}>{Math.round(trip.maxSpeedKmh)} km/h</Text><Text style={s.statK}>Top speed</Text></View>
        <View style={s.sep} />
        <View style={s.stat}><Text style={s.statV}>{elapsed(trip.startedAt)}</Text><Text style={s.statK}>Started</Text></View>
      </View>

      {/* Live / Last trip badge */}
      <View style={[s.liveBadge, trip.status !== 'active' && s.lastBadge]}>
        <View style={[s.liveDot, trip.status !== 'active' && s.lastDot]} />
        <Text style={[s.liveText, trip.status !== 'active' && s.lastText]}>
          {trip.status === 'active'
            ? `Live session · ${updatedAt ? `updated ${elapsed(updatedAt.toISOString())}` : ''}`
            : `Last trip · ended ${trip.endedAt ? elapsed(trip.endedAt) : ''}`}
        </Text>
        <TouchableOpacity onPress={() => fetchSession(true)} style={{ padding: 4 }}>
          <Text style={{ color: trip.status === 'active' ? C.green : C.muted, fontSize: 16 }}>↻</Text>
        </TouchableOpacity>
      </View>

      {/* Speed legend */}
      <View style={s.legend}>
        {([['#059669','<40'], ['#d97706','40-80'], ['#dc2626','>80']] as const).map(([c, l]) => (
          <View key={l} style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: c }]} />
            <Text style={s.legendText}>{l} km/h</Text>
          </View>
        ))}
      </View>

      {/* Leaflet map — web: react-leaflet (GPU canvas), native: WebView+Leaflet */}
      <View style={s.mapWrap}>
        {points.length === 0 ? (
          <View style={s.noGps}>
            <Text style={s.noGpsText}>
              {trip.status === 'active'
                ? 'Waiting for GPS points…\nPull down to refresh.'
                : 'No GPS points recorded for this trip.\nPull down to refresh.'}
            </Text>
          </View>
        ) : (
          <LeafletMap points={points.map(p => ({ ...p, speedKmh: p.speedKmh ?? 0 }))} />
        )}
      </View>

      <TabBar />
    </View>
  );
}

const s = StyleSheet.create({
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  loadText:  { marginTop: 12, color: C.muted, fontSize: 14 },

  statsBar:  { flexDirection: 'row', backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border, paddingVertical: 10, paddingHorizontal: 6 },
  stat:      { flex: 1, alignItems: 'center' },
  statV:     { fontSize: 14, fontWeight: '800', color: C.text },
  statK:     { fontSize: 9.5, color: C.muted, marginTop: 1, textTransform: 'uppercase', letterSpacing: 0.4 },
  sep:       { width: 1, backgroundColor: C.border, marginVertical: 4 },

  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: C.greenBg, borderBottomWidth: 1, borderBottomColor: '#a7f3d0' },
  liveDot:   { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
  liveText:  { flex: 1, fontSize: 12, color: C.green, fontWeight: '600' },
  lastBadge: { backgroundColor: '#f8fafc', borderBottomColor: '#e2e8f0' },
  lastDot:   { backgroundColor: '#94a3b8' },
  lastText:  { color: '#64748b' },

  legend:     { flexDirection: 'row', gap: 14, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:  { width: 22, height: 4, borderRadius: 2 },
  legendText: { fontSize: 11, color: C.muted },

  mapWrap:   { flex: 1 },
  noGps:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  noGpsText: { textAlign: 'center', color: C.muted, fontSize: 14, lineHeight: 22 },

  emptyCard:  { backgroundColor: C.surface, borderRadius: 20, padding: 32, alignItems: 'center', width: '100%', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 4 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 8 },
  emptyBody:  { fontSize: 14, color: C.muted, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  retryBtn:   { backgroundColor: C.brandSoft, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 10 },
  retryText:  { color: C.brand, fontWeight: '700', fontSize: 14 },
});
