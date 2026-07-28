/* JSAN Fleet — admin panel service worker.
 *
 * Two jobs:
 *   1. Make the panel installable and survive a dead network (app shell caching).
 *   2. Receive Web Push and raise the driver-offline notification even when every tab
 *      is closed — this is the only code that runs when the panel isn't open.
 *
 * Caching strategy, and why:
 *   - navigations       -> network-first with a short timeout, falling back to the cached
 *                          shell. Always-fresh HTML matters because it is what names the
 *                          current hashed bundles; a stale shell would point at files the
 *                          server no longer has.
 *   - /assets, /icons   -> cache-first. Vite fingerprints these, so a hit is always correct
 *                          and a miss just fetches the new hash.
 *   - /api, /socket.io  -> never touched. Live tracking data must not be served from a cache.
 *
 * Note this file is served verbatim from public/ (no build step), so keep it plain ES5-ish
 * worker JS with no imports.
 */

const CACHE = 'jsan-panel-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];
const NAV_TIMEOUT_MS = 3500;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one 404 can't fail the whole install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isCacheableAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // map tiles, fonts: let the network handle it
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  // App shell: network-first, cache as we go, fall back to the last good copy offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      new Promise((resolve) => {
        let settled = false;
        const finish = (res) => {
          if (!settled) {
            settled = true;
            resolve(res);
          }
        };
        const fallback = setTimeout(() => {
          caches.match('/').then((hit) => hit && finish(hit));
        }, NAV_TIMEOUT_MS);

        fetch(req)
          .then((res) => {
            clearTimeout(fallback);
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy)).catch(() => {});
            finish(res);
          })
          .catch(() => {
            clearTimeout(fallback);
            caches.match('/').then((hit) =>
              finish(hit || new Response('Offline', { status: 503, statusText: 'Offline' }))
            );
          });
      })
    );
    return;
  }

  if (!isCacheableAsset(url)) return;

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});

/* ─────────────── Web Push ─────────────── */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'JSAN Fleet';
  const options = {
    body: data.body || '',
    // One tag per driver: a repeat alert replaces the old one instead of stacking a pile.
    tag: data.tag || 'jsan-alert',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    vibrate: [90, 50, 90],
    timestamp: data.ts ? Date.parse(data.ts) : Date.now(),
    // A driver dropping off the map should stay on screen until someone looks at it.
    requireInteraction: data.type === 'driver-offline',
    data: {
      url: data.url || '/',
      type: data.type || 'alert',
      driverId: data.driverId || null,
      ts: data.ts || null,
    },
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Let any open panel show the same alert as an in-app toast without waiting for its
      // socket round-trip (and so it works when the socket happens to be reconnecting).
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((c) => c.postMessage({ source: 'jsan-sw', kind: 'push', alert: data }));
      }),
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        // Hand the route to the running app so React can navigate without a full reload.
        client.postMessage({ source: 'jsan-sw', kind: 'navigate', url: target });
        return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

/* The browser can rotate a subscription (`pushsubscriptionchange`) without telling the page.
 * Re-subscribing here would need a bearer token the worker doesn't have, so instead the panel
 * re-POSTs its current subscription to /api/push/subscribe on every load — one app open and
 * the rotated endpoint is registered again. See src/lib/push.ts. */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
