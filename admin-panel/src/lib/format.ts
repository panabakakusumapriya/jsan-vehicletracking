export const km = (m: number | undefined) => `${((m ?? 0) / 1000).toFixed(1)} km`;
export const dt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—');
export const time = (s?: string | null) => (s ? new Date(s).toLocaleTimeString() : '—');

/**
 * Trip/session timestamps only (Trips list, Trip Detail, Session Map — startedAt/endedAt/GPS
 * point times). Deliberately renders in the VIEWING BROWSER'S OWN OS timezone with no
 * conversion, no timezone label or abbreviation, and no awareness of the driver's or the
 * trip's own timezone. The same session shows a different clock time to managers in different
 * countries — that's the intended behavior here, not a bug: the API returns a raw UTC instant
 * and does no timezone math, and neither does this. Everything else in the app (driver
 * joining/exit dates, Asset Custody/Reports, etc.) keeps using dt()/time() above — this is
 * scoped to trip sessions only, not a blanket replacement.
 */
export const sessionDt = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A span of time as working hours: "2h 14m", or "44m" under an hour. */
export const hm = (ms: number | null | undefined) => {
  const mins = Math.max(0, Math.round((ms ?? 0) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

/** How long a trip ran: start to end, or to now while it is still going. */
export const tripMs = (t: { startedAt: string; endedAt?: string | null }) =>
  Math.max(0, (t.endedAt ? new Date(t.endedAt).getTime() : Date.now()) - new Date(t.startedAt).getTime());

export function statusBadge(status: 'active' | 'completed' | 'timed_out') {
  if (status === 'active') return 'green';
  if (status === 'timed_out') return 'amber';
  return 'gray';
}
