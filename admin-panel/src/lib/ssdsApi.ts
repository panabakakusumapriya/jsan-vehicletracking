// SSDS API calls go through the same JSAN backend — the backend connects to the
// SSDS MongoDB directly, so there is no external dependency on the ssd-mail tool.
import { api, API_URL, tokenStore } from './api';

export const ssdsApi = {
  get: <T>(path: string) => api.get<T>(`/api/ssds${path}`),
  post: <T>(path: string, body: unknown) => api.post<T>(`/api/ssds${path}`, body),
  patch: <T>(path: string, body: unknown) => api.patch<T>(`/api/ssds${path}`, body),
  del: <T>(path: string) => api.del<T>(`/api/ssds${path}`),

  /** POST with FormData (multipart) for file uploads */
  postForm: async <T>(path: string, formData: FormData): Promise<T> => {
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    // Do NOT set Content-Type — browser sets it with boundary for multipart
    const res = await fetch(`${API_URL}/api/ssds${path}`, { method: 'POST', headers, body: formData });
    if (res.status === 401) { tokenStore.clear(); window.location.href = '/login'; }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data as T;
  },

  // File download (export endpoints return Excel)
  download: async (path: string) => {
    const headers: Record<string, string> = {};
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_URL}/api/ssds${path}`, { headers });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error || `Export failed (${res.status})`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const filename = /filename="?([^"]+)"?/.exec(disposition)?.[1] || 'export.xlsx';
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  },
};
