// Base URL for the API + Socket.IO.
//  - dev: '' => same-origin, vite proxies /api and /socket.io to the backend.
//  - prod (Vercel etc.): no proxy exists, so call the deployed backend directly.
//    Override with VITE_API_URL at build time if the backend URL changes.
const DEFAULT_PROD_API = 'https://backend-jsan-vehicletracking-production.up.railway.app';

/**
 * In DEV this is always '' — same-origin, so /api goes through the Vite proxy to whatever backend
 * vite.config.ts chose (localhost:4000 by default, overridable with BACKEND_URL).
 *
 * VITE_API_URL is deliberately ignored in dev, despite being read here before. `.env.local` is
 * written by the Vercel CLI and pins VITE_API_URL to the production Railway URL — so `npm run dev`
 * silently sent every local request to PRODUCTION. Local backend changes appeared to do nothing,
 * and local testing was mutating live data. `.env.example` already documented this variable as
 * "production build only"; the code just did not honour it.
 *
 * To point dev at a different backend, set BACKEND_URL for the Vite proxy — the target is printed
 * at startup, so which backend you are on is never a guess.
 */
export const API_URL = import.meta.env.PROD
  ? (import.meta.env.VITE_API_URL ?? DEFAULT_PROD_API)
  : '';

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
  // PUT rather than PATCH where the body REPLACES a collection rather than amending a resource —
  // e.g. "these are the drivers on this area now", which has to be able to express "nobody".
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// Fetches a file (KML/JSON/zip export) with the same Bearer auth as `api`,
// then saves it via a synthetic link click -- a plain <a href> can't carry
// the token, since auth here is a header, not a cookie. Filename comes from
// the server's Content-Disposition header (it knows the trip/driver names).
export async function downloadFile(path: string, fallbackFilename = 'download'): Promise<void> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { headers });
  if (res.status === 401) {
    tokenStore.clear();
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    let message = `Export failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* response wasn't JSON -- keep the generic message */
    }
    throw new Error(message);
  }

  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] || fallbackFilename;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The viewer's IANA timezone, sent with date-filtered queries.
 *
 * Trip times are rendered in the viewer's local zone, so the filter has to use the same clock or
 * the two disagree at day boundaries: a trip starting 21:36Z shows as the 18th to a +5:30 viewer
 * while a UTC filter files it under the 17th, and it vanishes from a same-day search.
 */
export const viewerTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/**
 * PUT a file to the API as a RAW request body, reporting upload progress.
 *
 * Not multipart, and not `fetch`. The customer's road-network archive is ~80 MB and the boundary
 * another few, so two things matter: the server must be able to stream it to disk instead of
 * buffering a multipart body in the heap (see network.controller.js#uploadLayer), and the operator
 * must be able to see it moving. `fetch` still has no upload-progress event, so this is XHR.
 */
export function uploadRaw<T>(
  path: string,
  file: File,
  onProgress?: (percent: number, loaded: number, total: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}${path}`);

    const token = tokenStore.get();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/zip');
    // The filename travels in a header because the body is the file itself, with nothing
    // left to carry it.
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name).replace(/%20/g, ' '));

    xhr.upload.onprogress = (e) => {
      if (!onProgress || !e.lengthComputable) return;
      onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
    };

    xhr.onload = () => {
      let data: unknown = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        /* non-JSON error page — fall through to the status-code message */
      }
      if (xhr.status === 401) {
        tokenStore.clear();
        window.location.href = '/login';
        reject(new Error('Not authenticated'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new Error((data as { error?: string })?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));

    xhr.send(file);
  });
}
