import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import {
  apiMyDay,
  apiReportDowntime,
  apiWithdrawDowntime,
  type DowntimeReason,
  type MyDay,
  type MyDowntime,
} from '@/src/lib/api';
import { ModalSheet } from '@/src/components/ModalSheet';
import { deviceTimezone } from '@/src/lib/timezone';

/**
 * "Today's work". On the Home screen it is one compact card — the day's working hours, trips and
 * km, and what still needs the driver (downtime waiting for approval, stops with no reason yet) —
 * so the screen stays short. Tapping it opens a bottom sheet (ModalSheet) with the whole day: each
 * trip start – end and how long it ran, the downtime between them, the total as the last row, and
 * ‹ › to step back through earlier days. Adding downtime is a page of the same sheet.
 *
 * Working hours are every trip's start to end added up, plus DOWNTIME a manager has approved: time
 * the driver was stopped for a reason (a weather stop, a vehicle change-over). Each gap between
 * trips is shown with "Add downtime"; so is the time just before the first trip and after the last.
 * The server checks every entry (services/downtime.js) and says why when it cannot be saved;
 * pending downtime is shown, not counted, until approved. The same figure as the admin panel's
 * Trips page for that driver-day. A trip still running keeps counting on screen.
 */

const C = {
  brand: '#7c3aed',
  surface: '#ffffff',
  border: '#e9ecf0',
  text: '#0d0d12',
  text2: '#374151',
  muted: '#9ca3af',
  green: '#059669',
  amber: '#b45309',
  amberBg: '#fef3c7',
  red: '#b91c1c',
  redBg: '#fee2e2',
  greenBg: '#d1fae5',
  totalBg: '#f5f3ff',
};

const MIN = 60_000;
/** As the server: how far before the first trip / after the last downtime may reach. */
const EDGE_MS = 3 * 60 * MIN;

const REASONS: { key: DowntimeReason; label: string }[] = [
  { key: 'weather', label: 'Weather' },
  { key: 'vehicle_changeover', label: 'Vehicle change-over' },
  { key: 'vehicle_issue', label: 'Vehicle issue' },
  { key: 'road_closed', label: 'Road closed' },
  { key: 'waiting_instructions', label: 'Waiting for instructions' },
  { key: 'fuel', label: 'Fuel' },
  { key: 'other', label: 'Other' },
];
const reasonLabel = (k: DowntimeReason) => REASONS.find((r) => r.key === k)?.label ?? k;

const pad = (n: number) => String(n).padStart(2, '0');
/** The device's local calendar day, `offset` days back from today, as YYYY-MM-DD. */
function localDate(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const clockMs = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const clock = (iso: string) => clockMs(new Date(iso).getTime());
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
const newId = () => `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** How far back the arrows go — the same month a driver might be asked about. */
const MAX_DAYS_BACK = 31;

type Span = [number, number];
/** `window` minus the `taken` spans, as the free pieces of at least a minute. */
function freeParts(window: Span, taken: Span[]): Span[] {
  let parts: Span[] = [window];
  for (const [s, e] of taken) {
    parts = parts.flatMap(([a, b]): Span[] => (e <= a || s >= b ? [[a, b]] : [[a, Math.min(b, s)], [Math.max(a, e), b]]));
  }
  return parts.filter(([a, b]) => b - a >= MIN);
}

/** Where a new entry may go, and what it starts out as. */
type Slot = { kind: 'gap' | 'before' | 'after'; min: number; max: number; start: number; end: number };

type Row =
  | { type: 'trip'; at: number; trip: MyDay['trips'][number] }
  | { type: 'downtime'; at: number; d: MyDowntime }
  | { type: 'slot'; at: number; slot: Slot };

export function DayWork({ token, refreshKey }: { token: string | null; refreshKey: number }) {
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState<MyDay | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Slot | null>(null);
  /** The bottom sheet with the whole day. */
  const [open, setOpen] = useState(false);
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
  const downtime = useMemo(() => shown?.downtime ?? [], [shown]);
  const tripMs = shown ? shown.trips.reduce((a, t) => a + durationOf(t), 0) : 0;
  const approvedMs = downtime.filter((d) => d.status === 'approved').reduce((a, d) => a + d.durationMs, 0);
  const pendingMs = downtime.filter((d) => d.status === 'pending').reduce((a, d) => a + d.durationMs, 0);
  const workMs = tripMs + approvedMs;

  /** Trips, downtime and the free time around them, in time order. */
  const rows = useMemo<Row[]>(() => {
    if (!shown) return [];
    const now = Date.now();
    const trips = shown.trips;
    const spans: Span[] = trips.map((t) => [new Date(t.startedAt).getTime(), t.endedAt ? new Date(t.endedAt).getTime() : now]);
    const taken: Span[] = downtime
      .filter((d) => d.status !== 'rejected')
      .map((d) => [new Date(d.startAt).getTime(), new Date(d.endAt).getTime()]);
    const out: Row[] = [
      ...trips.map((trip, i): Row => ({ type: 'trip', at: spans[i][0], trip })),
      ...downtime.map((d): Row => ({ type: 'downtime', at: new Date(d.startAt).getTime(), d })),
    ];
    // Only against a server that knows about downtime (older ones send no `downtime`).
    if (spans.length && shown.downtime) {
      // Between trips: every free piece of every gap.
      for (let i = 0; i + 1 < spans.length; i++) {
        for (const [a, b] of freeParts([spans[i][1], spans[i + 1][0]], taken)) {
          out.push({ type: 'slot', at: a, slot: { kind: 'gap', min: a, max: b, start: a, end: b } });
        }
      }
      // Before the first trip: the half hour leading up to it, movable back to 3 hours.
      const first = spans[0][0];
      const before = freeParts([first - EDGE_MS, first], taken).pop();
      if (before) {
        out.push({ type: 'slot', at: first - 1, slot: { kind: 'before', min: before[0], max: before[1], start: Math.max(before[0], before[1] - 30 * MIN), end: before[1] } });
      }
      // After the last trip, once the day's driving has stopped.
      if (!trips.some((t) => !t.endedAt)) {
        const last = Math.max(...spans.map(([, e]) => e));
        const after = freeParts([last, Math.min(now, last + EDGE_MS)], taken)[0];
        if (after) {
          out.push({ type: 'slot', at: Number.MAX_SAFE_INTEGER, slot: { kind: 'after', min: after[0], max: after[1], start: after[0], end: Math.min(after[1], after[0] + 30 * MIN) } });
        }
      }
    }
    return out.sort((x, y) => x.at - y.at);
  }, [shown, downtime]);

  const withdraw = (d: MyDowntime) => {
    if (!token) return;
    Alert.alert('Take back this downtime?', `${reasonLabel(d.reason)} ${clock(d.startAt)}–${clock(d.endAt)}`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Take back',
        style: 'destructive',
        onPress: async () => {
          try { await apiWithdrawDowntime(token, d.id); } catch (e) { Alert.alert('Could not take it back', e instanceof Error ? e.message : 'Try again'); }
          load();
        },
      },
    ]);
  };

  const gaps = rows.filter((r) => r.type === 'slot' && r.slot.kind === 'gap').length;
  const closeSheet = () => { setOpen(false); setEditing(null); setOffset(0); };

  return (
    <>
      {/* On the screen: one line of the day. Everything else is in the sheet. */}
      <TouchableOpacity style={s.card} onPress={() => setOpen(true)} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Open working hours">
        <View style={s.head}>
          <Text style={s.title}>Working hours · {dayLabel(offset, date)}</Text>
          <Text style={s.viewLink}>View ›</Text>
        </View>
        {!shown ? (
          <View style={s.empty}>
            {loading ? <ActivityIndicator color={C.brand} /> : <Text style={s.muted}>{error ?? 'No trips yet.'}</Text>}
          </View>
        ) : (
          <>
            <View style={s.summary}>
              <Text style={s.summaryBig}>{hm(workMs)}</Text>
              <Text style={s.summarySub}>
                {shown.trips.length} trip{shown.trips.length === 1 ? '' : 's'} · {km(shown.totals.distanceMeters)}
                {approvedMs > 0 ? ` · incl. ${hm(approvedMs)} downtime` : ''}
              </Text>
            </View>
            {(pendingMs > 0 || gaps > 0) && (
              <View style={s.summaryChips}>
                {pendingMs > 0 && <Text style={[s.badge, s.badgeWait]}>{hm(pendingMs)} waiting for approval</Text>}
                {gaps > 0 && <Text style={[s.badge, s.badgeGap]}>{gaps} stop{gaps === 1 ? '' : 's'} — add a reason</Text>}
              </View>
            )}
          </>
        )}
      </TouchableOpacity>

      <ModalSheet visible={open} onClose={closeSheet}>
        {editing && token ? (
          <DowntimeForm
            slot={editing}
            token={token}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : (
          <ScrollView contentContainerStyle={s.sheetBody}>
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
          {rows.map((r) => {
            if (r.type === 'trip') {
              const t = r.trip;
              return (
                <View key={`t-${t.id}`} style={s.row}>
                  <Text style={s.cTime}>
                    {clock(t.startedAt)} – {t.endedAt ? clock(t.endedAt) : <Text style={{ color: C.green, fontWeight: '700' }}>now</Text>}
                  </Text>
                  <Text style={s.cDur}>{hm(durationOf(t))}</Text>
                  <Text style={s.cKm}>{km(t.distanceMeters)}</Text>
                </View>
              );
            }
            if (r.type === 'downtime') {
              const d = r.d;
              const badge = d.status === 'approved' ? [s.badgeOk, 'Approved'] : d.status === 'rejected' ? [s.badgeNo, 'Not approved'] : [s.badgeWait, 'Waiting for approval'];
              return (
                <View key={`d-${d.id}`} style={[s.row, s.dtRow]}>
                  <View style={{ flex: 1 }}>
                    <View style={s.dtTop}>
                      <Text style={[s.cTime, d.status === 'rejected' && s.struck]}>
                        {clock(d.startAt)} – {clock(d.endAt)}
                      </Text>
                      <Text style={[s.cDur, d.status === 'rejected' && s.struck]}>{hm(d.durationMs)}</Text>
                      <View style={s.cKm} />
                    </View>
                    <View style={s.dtMeta}>
                      <Text style={s.dtReason}>⏸ {reasonLabel(d.reason)}{d.note ? ` · ${d.note}` : ''}</Text>
                      <Text style={[s.badge, badge[0] as object]}>{badge[1] as string}</Text>
                      {d.status === 'pending' && (
                        <TouchableOpacity onPress={() => withdraw(d)} hitSlop={8}>
                          <Text style={s.link}>Take back</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    {d.status === 'rejected' && d.reviewNote ? <Text style={s.reviewNote}>Manager: {d.reviewNote}</Text> : null}
                  </View>
                </View>
              );
            }
            const sl = r.slot;
            const label =
              sl.kind === 'gap'
                ? `${clockMs(sl.min)} – ${clockMs(sl.max)} · ${hm(sl.max - sl.min)} stopped`
                : sl.kind === 'before'
                  ? 'Before your first trip'
                  : 'After your last trip';
            return (
              <TouchableOpacity key={`s-${sl.kind}-${sl.min}`} style={s.slot} onPress={() => setEditing(sl)} accessibilityRole="button">
                <Text style={s.slotText}>{label}</Text>
                <Text style={s.slotAdd}>＋ Add downtime</Text>
              </TouchableOpacity>
            );
          })}
          <View style={[s.row, s.total]}>
            <Text style={[s.cTime, s.totalText]}>
              Total · {shown.trips.length} trip{shown.trips.length === 1 ? '' : 's'}
            </Text>
            <Text style={[s.cDur, s.totalText, { color: C.brand }]}>{hm(workMs)}</Text>
            <Text style={[s.cKm, s.totalText]}>{km(shown.totals.distanceMeters)}</Text>
          </View>
          {(approvedMs > 0 || pendingMs > 0) && (
            <Text style={s.totalNote}>
              {hm(tripMs)} driving{approvedMs > 0 ? ` + ${hm(approvedMs)} approved downtime` : ''}
              {pendingMs > 0 ? ` · ${hm(pendingMs)} waiting for approval (not counted yet)` : ''}
            </Text>
          )}
          {error && <Text style={[s.muted, { marginTop: 6 }]}>Showing the last loaded figures — {error}</Text>}
        </>
      )}

          </ScrollView>
        )}
      </ModalSheet>
    </>
  );
}

/** Reason, start and end (moved in 5-minute steps inside the free time), an optional note. */
function DowntimeForm({ slot, token, onClose, onSaved }: { slot: Slot; token: string; onClose: () => void; onSaved: () => void }) {
  const [start, setStart] = useState(slot.start);
  const [end, setEnd] = useState(slot.end);
  const [reason, setReason] = useState<DowntimeReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clientId = useRef(newId()).current;

  const step = (which: 'start' | 'end', minutes: number) => {
    const d = minutes * MIN;
    if (which === 'start') setStart((v) => Math.min(Math.max(slot.min, v + d), end - MIN));
    else setEnd((v) => Math.max(Math.min(slot.max, v + d), start + MIN));
  };
  const canSave = Boolean(reason) && end - start >= MIN && (reason !== 'other' || note.trim().length > 0) && !busy;

  const save = async () => {
    if (!reason) return;
    setBusy(true);
    setErr(null);
    try {
      await apiReportDowntime(token, {
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        reason,
        note: note.trim() || undefined,
        tz: deviceTimezone(),
        clientId,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save — check your signal and try again');
    } finally {
      setBusy(false);
    }
  };

  const Stepper = ({ which, value }: { which: 'start' | 'end'; value: number }) => (
    <View style={s.stepper}>
      <Text style={s.stepLabel}>{which === 'start' ? 'From' : 'To'}</Text>
      <TouchableOpacity style={s.stepBtn} onPress={() => step(which, -5)} accessibilityLabel={`${which} 5 minutes earlier`}>
        <Text style={s.stepBtnText}>−5</Text>
      </TouchableOpacity>
      <Text style={s.stepValue}>{clockMs(value)}</Text>
      <TouchableOpacity style={s.stepBtn} onPress={() => step(which, 5)} accessibilityLabel={`${which} 5 minutes later`}>
        <Text style={s.stepBtnText}>+5</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.sheetBody}>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={{ alignSelf: 'flex-start', marginBottom: 6 }}>
            <Text style={s.link}>‹ Back to the day</Text>
          </TouchableOpacity>
          <Text style={s.sheetTitle}>Add downtime</Text>
          <Text style={s.sheetSub}>
            Time you were working but stopped. It counts toward your working hours once your manager approves it.
          </Text>

          <Text style={s.fieldLabel}>Why were you stopped?</Text>
          <View style={s.chips}>
            {REASONS.map((r) => (
              <TouchableOpacity key={r.key} style={[s.chip, reason === r.key && s.chipOn]} onPress={() => setReason(r.key)}>
                <Text style={[s.chipText, reason === r.key && s.chipTextOn]}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.fieldLabel}>When · {hm(end - start)}</Text>
          <Stepper which="start" value={start} />
          <Stepper which="end" value={end} />

          <Text style={s.fieldLabel}>Note {reason === 'other' ? '(needed)' : '(optional)'}</Text>
          <TextInput
            style={s.input}
            value={note}
            onChangeText={setNote}
            placeholder="e.g. heavy rain, waited for it to clear"
            placeholderTextColor={C.muted}
            maxLength={300}
            multiline
          />

          {err && <Text style={s.err}>{err}</Text>}
          <View style={s.sheetBtns}>
            <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={onClose}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, !canSave && { opacity: 0.45 }]} onPress={save} disabled={!canSave}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Send for approval</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, shadowColor: '#0f172a', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
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
  totalNote: { fontSize: 12, color: C.text2, marginTop: 6, paddingHorizontal: 8 },

  dtRow: { alignItems: 'flex-start' },
  dtTop: { flexDirection: 'row', alignItems: 'center' },
  dtMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  dtReason: { fontSize: 12.5, color: C.text2 },
  struck: { textDecorationLine: 'line-through', color: C.muted },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 99, overflow: 'hidden' },
  badgeWait: { backgroundColor: C.amberBg, color: C.amber },
  badgeOk: { backgroundColor: C.greenBg, color: C.green },
  badgeNo: { backgroundColor: C.redBg, color: C.red },
  link: { fontSize: 12, fontWeight: '700', color: C.brand },
  reviewNote: { fontSize: 12, color: C.red, marginTop: 3 },

  slot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: C.border, borderStyle: 'dashed', borderRadius: 10,
    paddingVertical: 8, paddingHorizontal: 10, marginVertical: 4,
  },
  slotText: { fontSize: 12.5, color: C.text2, fontVariant: ['tabular-nums'] },
  slotAdd: { fontSize: 12.5, fontWeight: '700', color: C.brand },

  sheetBody: { paddingHorizontal: 18, paddingBottom: 24 },
  viewLink: { fontSize: 13, fontWeight: '700', color: C.brand },
  summary: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  summaryBig: { fontSize: 26, fontWeight: '800', color: C.text, fontVariant: ['tabular-nums'] },
  summarySub: { fontSize: 13, color: C.text2 },
  summaryChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badgeGap: { backgroundColor: '#ede9fe', color: C.brand },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  sheetSub: { fontSize: 13, color: C.text2, marginTop: 4, lineHeight: 18 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.3, marginTop: 16, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 7 },
  chipOn: { backgroundColor: C.brand, borderColor: C.brand },
  chipText: { fontSize: 13, color: C.text2, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  stepLabel: { width: 44, fontSize: 13, color: C.text2, fontWeight: '600' },
  stepBtn: { width: 46, height: 36, borderRadius: 10, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 14, fontWeight: '700', color: C.text2 },
  stepValue: { minWidth: 64, textAlign: 'center', fontSize: 18, fontWeight: '800', color: C.text, fontVariant: ['tabular-nums'] },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 10, minHeight: 60, fontSize: 14, color: C.text, textAlignVertical: 'top' },
  err: { color: C.red, fontSize: 13, marginTop: 12 },
  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: 18, marginBottom: 6 },
  btn: { flex: 1, height: 46, borderRadius: 12, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  btnGhost: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  btnGhostText: { color: C.text2, fontWeight: '700', fontSize: 15 },
});
