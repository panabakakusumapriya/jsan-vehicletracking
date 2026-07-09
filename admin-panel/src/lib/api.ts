// Base URL for the API + Socket.IO.
//  - dev: '' => same-origin, vite proxies /api and /socket.io to the backend.
//  - prod (Vercel etc.): no proxy exists, so call the deployed backend directly.
//    Override with VITE_API_URL at build time if the backend URL changes.
const DEFAULT_PROD_API = 'https://backend-jsan-vehicletracking-production.up.railway.app';
export const API_URL =
  import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? DEFAULT_PROD_API : '');

const TOKEN_KEY = 'jsan_admin_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) {
    tokenStore.clear();
    if (!path.includes('/auth/login')) window.location.href = '/login';
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
