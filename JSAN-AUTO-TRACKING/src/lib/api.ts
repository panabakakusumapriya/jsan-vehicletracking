import { API_BASE_URL } from './config';

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
