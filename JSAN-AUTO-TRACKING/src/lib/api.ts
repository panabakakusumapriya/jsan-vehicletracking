import { API_BASE_URL } from './config';

/**
 * Set by AuthProvider so a 401 anywhere can end the session exactly once.
 *
 * A module-level hook rather than an import of the auth module: auth imports this file, and
 * importing it back would be a require cycle that resolves to undefined at load time.
 */
type UnauthorizedHandler = (reason: string) => void;
let onUnauthorized: UnauthorizedHandler | null = null;
let lastNotifiedAt = 0;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn;
}

function notifyUnauthorized(reason: string) {
  // The map screen polls every 15s and fires several requests at once; without this every one of
  // them would trigger a separate sign-out.
  const now = Date.now();
  if (now - lastNotifiedAt < 5000) return;
  lastNotifiedAt = now;
  onUnauthorized?.(reason);
}

export type AuthUser = {
  _id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'user';
  vehicleId?: string | null;
  timezone?: string | null;
  country?: string | null;
};

async function request(path: string, options: RequestInit = {}, token?: string | null) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Prefer the server's human-readable `message`; keep the machine `code` for the UI to branch on.
    const err = new Error(data?.message || data?.error || `Request failed (${res.status})`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = data?.error;
    err.status = res.status;

    /**
     * A rejected token must be visible as "sign in again", not as empty data.
     *
     * Tokens are signed per backend. Point the app at a different one — a local server, a
     * re-keyed deploy — and the stored token is refused with a 401. Every screen then caught the
     * error and rendered its empty state, so a 401 was indistinguishable from "you have no work
     * areas allocated": the driver sees nothing wrong, and the real cause is only visible in the
     * server log.
     *
     * Notifying here lets AuthProvider clear the session once, from anywhere, rather than each
     * screen having to recognise it.
     */
    if (res.status === 401) notifyUnauthorized(err.message);

    throw err;
  }
  return data;
}

export function apiLogin(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function apiLogout(token: string): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' }, token);
}

export function apiMe(token: string): Promise<{ user: AuthUser }> {
  return request('/api/auth/me', {}, token);
}

export function apiUpdateTimezone(
  token: string,
  data: { timezone: string; country?: string },
): Promise<{ ok: boolean; timezone: string; country: string; user?: AuthUser }> {
  return request('/api/auth/timezone', { method: 'PATCH', body: JSON.stringify(data) }, token);
}

export type ReverseGeoResult = {
  timezone: string;
  country: string;
  countryCode: string;
  displayName: string;
};

/** One work area the driver has been allocated. Geometry is the simplified outline. */
export type MyArea = {
  id: string;
  areaCode: string;
  name: string;
  parentName: string | null;
  priority: number;
  targetMeters: number;
  targetLinks: number;
  bbox?: [number, number, number, number] | null;
  outline: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] } | null;
  assignedAt: string | null;
};

/**
 * The areas this driver is meant to cover, as allocated in the admin portal.
 *
 * Called sparingly (screen focus / pull-to-refresh), never polled: an allocation changes when a
 * manager changes it, which is a few times a week at most, and this fleet has just come off a
 * 25 GB month. `updatedAt` lets the caller skip re-rendering when nothing moved.
 */
export function apiMyAreas(token: string): Promise<{ areas: MyArea[]; updatedAt: string | null }> {
  return request('/api/tracking/my-areas', {}, token);
}

/**
 * One assigned road link inside a work area.
 *
 * A positional tuple, not an object: this payload carries up to 20,000 links and the same four
 * key names repeated 20,000 times is tens of kilobytes of pure JSON punctuation on a connection
 * that has already produced a 25 GB month. Labelled tuple elements keep it readable in the editor
 * without costing a byte on the wire.
 *
 * `covered` is 1 when the link is already in the LinkCoverage ledger (driven), 0 when it is still
 * outstanding. Coordinates are [lon, lat] — GeoJSON order, matching everything else geometric in
 * this codebase — rounded server-side to 5 decimals (~1 m), which is far finer than the accuracy
 * of a phone GPS fix and is where most of the size reduction comes from.
 */
export type MyRoadLink = [
  linkId: string,
  funcClass: number,
  covered: 0 | 1,
  lonLat: [number, number][],
];

export type MyRoads = {
  areaId: string;
  /**
   * Cache key, NOT a schema version. The server changes it whenever coverage inside this area
   * changes, so a client holding the same `version` is holding data that is still correct and can
   * skip re-rendering — and, more to the point, must not be made to re-download.
   */
  version: string;
  /** True when the area held more links than the server's cap and the list was cut short. */
  truncated: boolean;
  count: number;
  links: MyRoadLink[];
};

/**
 * Every road link in one of the driver's allocated areas, flagged driven/not-driven.
 *
 * NEVER call this directly from a screen — go through src/lib/roadCache.ts. A single area is up
 * to ~253 KB gzipped (a few MB once parsed), so this is a once-per-shift fetch that must be
 * cached to disk, not something to re-run whenever the map screen mounts.
 *
 * 403s unless the caller holds a live assignment for `areaId` on the active network version.
 */
export function apiMyRoads(token: string, areaId: string): Promise<MyRoads> {
  return request(`/api/tracking/my-roads?areaId=${encodeURIComponent(areaId)}`, {}, token);
}
