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
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export function apiLogin(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  return request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function apiMe(token: string): Promise<{ user: AuthUser }> {
  return request('/api/auth/me', {}, token);
}
