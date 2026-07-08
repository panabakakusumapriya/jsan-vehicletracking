export const km = (m: number | undefined) => `${((m ?? 0) / 1000).toFixed(1)} km`;
export const dt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—');
export const time = (s?: string | null) => (s ? new Date(s).toLocaleTimeString() : '—');

export function statusBadge(status: 'active' | 'completed' | 'timed_out') {
  if (status === 'active') return 'green';
  if (status === 'timed_out') return 'amber';
  return 'gray';
}
