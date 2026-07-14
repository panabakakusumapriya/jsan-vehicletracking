import { API_BASE_URL } from './config';

export type AuthUser = {
  _id: string;
  name: string;
  email: string;
  role: 'admin' | 'manager' | 'user';
  vehicleId?: string | null;
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
