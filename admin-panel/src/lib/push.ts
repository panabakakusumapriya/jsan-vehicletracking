// Web Push subscription plumbing: ask the browser for permission, hand the resulting
// endpoint to the backend, and keep the two in sync.
//
// The backend fans an alert out to every subscription owned by a user, so a manager with
// the panel on both a phone and a laptop simply has two rows and gets both.

import { api } from './api';
import { registerServiceWorker } from './pwa';

export type PushState =
  | 'unsupported' // no service worker / PushManager (old browser, or iOS Safari in a tab)
  | 'unconfigured' // server has no VAPID keys, so nothing can be delivered
  | 'denied' // the user said no; only they can undo it, in browser settings
  | 'off' // supported and allowed to ask, but not subscribed
  | 'on';

// VAPID keys travel as base64url; PushManager wants raw bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

let cachedKey: string | null | undefined;

async function serverPublicKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const res = await api.get<{ publicKey: string | null; configured: boolean }>(
      '/api/push/public-key'
    );
    cachedKey = res.configured ? res.publicKey : null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

function toJSON(sub: PushSubscription) {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    userAgent: navigator.userAgent,
  };
}

/** Current state, without prompting for anything. */
export async function getPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (!(await serverPublicKey())) return 'unconfigured';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/**
 * Turn alerts on. MUST be called from a user gesture — iOS rejects
 * Notification.requestPermission() outside one, and Chrome ignores repeat prompts.
 */
export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';

  const key = await serverPublicKey();
  if (!key) return 'unconfigured';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
  if (!reg) return 'unsupported';
  await navigator.serviceWorker.ready;

  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      // Required by Chrome: every push we send must surface a visible notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    }));

  await api.post('/api/push/subscribe', toJSON(sub));
  return 'on';
}

/** Turn alerts off on this device (the browser-level permission is left alone). */
export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return 'off';
  // Tell the server first: if unsubscribe() succeeds but the POST fails we would keep
  // getting sends to a dead endpoint until the push service 410s it.
  await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  return 'off';
}

/**
 * Re-register an existing subscription with the backend on boot.
 *
 * Covers two cases without bothering the user: the browser silently rotated the endpoint
 * (`pushsubscriptionchange`, which a worker can't report because it has no auth token),
 * and the same device now being used by a different signed-in account.
 */
export async function syncExistingSubscription(): Promise<void> {
  if (!isPushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api.post('/api/push/subscribe', toJSON(sub));
  } catch {
    /* best effort — a failed re-sync just means alerts stay bound to the last known user */
  }
}

export async function sendTestNotification(): Promise<void> {
  await api.post('/api/push/test', {});
}
