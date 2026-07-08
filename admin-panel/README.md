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

## Verified
- ✅ `npm run build` — strict TypeScript typecheck + Vite production bundle both pass.
- ⏳ Live end-to-end (login → live markers) needs the backend running against a MongoDB.
