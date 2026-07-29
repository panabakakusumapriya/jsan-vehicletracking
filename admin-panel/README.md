# JSAN Fleet — Admin Panel (React + Vite + Leaflet)

Web dashboard for **admins** and **managers** to watch drivers live and manage the fleet.
Drivers (`user` role) cannot log in here — they use the mobile app.

## Features

- **Live Map** — OpenStreetMap (Leaflet) with a moving marker per active driver, updated in
  real time over Socket.IO. Green = fresh, amber = stale (no heartbeat recently). Click a
  driver to fly to them. Seeds from `GET /api/tracking/live`, then streams `location` events.
- **Trips** — filterable list; open one to see its full path drawn as a polyline with
  start/end markers and distance / max-speed / point-count stats.
- **Drivers** — create drivers, assign a vehicle (and, for admins, a manager); deactivate.
- **Vehicles** — create/assign/delete vehicles.
- **Managers** (admin only) — create/deactivate managers.
- **Installable app (PWA) + driver-offline alerts** — see below.

Role scoping is enforced by the backend: a **manager** only ever sees their own drivers,
vehicles, trips and live positions; an **admin** sees everything.

## Run (dev)

The backend must be running first (`cd ../backend && npm run dev`).

```bash
cd admin-panel
npm install
npm run dev        # http://localhost:5173
```

`vite.config.ts` proxies `/api` and `/socket.io` to `http://localhost:4000`
(override with `BACKEND_URL=...`), so there's no CORS setup and websockets upgrade cleanly.

Log in with a seeded account (run `npm run seed` in the backend):
- admin — `admin@jsan.local` / `Admin@12345`
- manager — `manager@jsan.local` / `Manager@12345`

## Build (production)

```bash
npm run build      # -> dist/  (static; serve behind any web server / CDN)
```

For production set `VITE_API_URL` to the backend's public URL, and set the backend's
`CORS_ORIGIN` to this panel's origin.

## PWA — install once, get alerted

The panel installs to a phone home screen / desktop dock and keeps receiving
**driver-offline notifications while it is closed**.

| Piece | Where |
|---|---|
| Manifest + icons | `public/manifest.webmanifest`, `public/icons/` (regenerate: `npm run icons`) |
| Service worker | `public/sw.js` — app-shell cache, `push`, `notificationclick` |
| Registration / install state | `src/lib/pwa.ts` |
| Subscribe / unsubscribe | `src/lib/push.ts` |
| One-time install + alerts nudge | `src/components/PwaBanner.tsx` |
| Always-available toggle | `src/components/AlertsBell.tsx` (sidebar footer) |
| In-app toasts | `src/components/AlertToaster.tsx` |

**The flow.** After signing in, a banner offers *Install app*. The gate is **state, not
history**: not installed → ask; installed → never ask again, in any window.

- Shown **once per sitting**, not once per page load: the marker lives in `sessionStorage`
  and is written when the banner reaches the screen (not when a button is clicked), so
  ignoring it, navigating or reloading will not bring it back. A new sitting while still
  uninstalled asks again — a permanent dismissal would quietly strand someone with no app,
  no push and no prompt to fix it.
- "Already installed" is answered by `isInstalled()`, in strict priority order:
  `isStandalone()` → `canInstall()` → `getInstalledRelatedApps()` → sticky local flag.
  `display-mode` alone is not enough (it is `false` in an ordinary tab even when the app
  *is* installed, so a Chrome address-bar install would otherwise be nagged forever), and
  the sticky flag must come **last** — Chrome only offers an install for an app it does not
  have, so that live offer both proves "not installed" and self-corrects the flag after an
  uninstall.

The sidebar bell is the manual way in after either banner is gone. Accepting the install
leads straight into *Turn on alerts*, which asks for notification permission and registers a
Web Push subscription with
`POST /api/push/subscribe`. From then on the backend watchdog pushes a notification whenever
one of that manager's drivers stops reporting for ~3 min. Tapping it opens the live map
centred on that driver (`/?driver=<id>`).

Caching is deliberately conservative: navigations are network-first (the HTML names the
current hashed bundles, so a stale shell would point at files that no longer exist), hashed
assets are cache-first, and `/api` + `/socket.io` are never cached — live tracking data must
never come from a cache.

**Platform notes**
- Android / desktop Chrome, Edge, Firefox: works in a plain tab; installing is optional.
- **iOS 16.4+: push only works once the app is added to the Home Screen** — the banner shows
  the Share → *Add to Home Screen* instructions there instead of a native install button.
- Requires HTTPS (or `localhost`). The backend needs `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
  set, otherwise the bell hides itself and only in-app toasts appear.

## Verified
- ✅ `npm run build` — strict TypeScript typecheck + Vite production bundle both pass.
- ✅ Backend alert path covered by `backend/npm test` (offline alert fires once, clears on
  recovery, non-managers rejected).
- ✅ Real end-to-end push: `POST /api/push/test` → Chrome push service → service worker
  `push` handler → system notification (`sent: 1`, correct title/body/tag).
- ✅ Install banner, driven in a real browser: shows when not installed; does **not** return
  after a reload in the same sitting; **does** ask again in a new sitting while still not
  installed; retracts immediately on `appinstalled` and stops asking.
