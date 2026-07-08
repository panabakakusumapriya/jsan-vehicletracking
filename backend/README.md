# JSAN Tracking — Backend (Express + MongoDB + Socket.IO)

Live vehicle-tracking API. Ingests location heartbeats from the driver mobile app
(every ~10s, plus offline SQLite batches), stores trips + points, and streams live
positions to the admin panel over Socket.IO.

## Roles

| Role     | Who            | Can do                                                        |
|----------|----------------|--------------------------------------------------------------|
| `admin`  | Company admin  | Everything: all users, vehicles, trips, live map             |
| `manager`| Fleet manager  | Manage **their** drivers + vehicles; see their live/trips     |
| `user`   | Driver (mobile)| Log in on the app; push location heartbeats; see own trips    |

## Setup

```bash
cd backend
cp .env.example .env      # then edit .env (Windows: copy .env.example .env)
#   -> put a FRESH MongoDB password + a long JWT_SECRET
npm install
npm run seed              # creates admin/manager/driver demo logins
npm run dev               # http://localhost:4000  (npm start for prod)
```

Health check: `GET http://localhost:4000/health`

Seeded logins (change in production):
- admin  — `admin@jsan.local` / `Admin@12345`
- manager — `manager@jsan.local` / `Manager@12345`
- driver  — `driver@jsan.local` / `Driver@12345`

## Auth

All `/api/*` routes except `/api/auth/login` need `Authorization: Bearer <token>`.
Socket.IO connects with `{ auth: { token } }`.

## Endpoints

### Auth
- `POST /api/auth/login` `{ email, password }` → `{ token, user }`
- `GET  /api/auth/me` → `{ user }`

### Users  (admin, manager)
- `GET  /api/users?role=user|manager`
- `POST /api/users` `{ name, email, password, phone?, role?, managerId?, vehicleId? }`
- `GET/PATCH/DELETE /api/users/:id`  (DELETE = soft, marks inactive)

### Vehicles  (admin, manager)
- `GET/POST /api/vehicles`, `PATCH/DELETE /api/vehicles/:id`

### Trips  (scoped to requester)
- `GET /api/trips?status=&driverId=&page=&limit=`
- `GET /api/trips/:id?points=true`  → trip + full path

### Tracking
- `POST /api/tracking/ingest`  (driver) — **the core endpoint**
- `GET  /api/tracking/live`  (admin, manager) — snapshot of active drivers

## The ingest model (heartbeat + offline sync in one)

The mobile app records a point roughly every 10s. Each point gets a device-side
`clientId` (uuid) and belongs to a `clientTripId` (uuid, created when a trip starts).
The **same** endpoint handles the online heartbeat (1 point) and the offline flush
(many points buffered in SQLite while there was no internet):

```
POST /api/tracking/ingest
{
  "points": [
    {
      "clientId": "9f1c…",        // uuid per point -> dedupe
      "clientTripId": "5a20…",    // uuid per trip  -> groups into one Trip
      "lat": 17.4123, "lon": 78.4456,
      "speedKmh": 42.6, "heading": 120, "accuracy": 8,
      "altitude": 540, "batteryLevel": 0.87, "isMoving": true,
      "recordedAt": "2026-07-08T10:00:00.000Z",
      "tripStatus": "active"       // or "ended" (speed hit 0) / "timed_out" (20-min no move)
    }
  ]
}
→ 200 { "accepted": 1, "acceptedClientIds": ["9f1c…"] }
```

Idempotency:
- `clientId` has a unique index → re-sending a point is ignored (still ack'd), so the
  app can safely **retry, then delete those rows from its local SQLite**.
- `clientTripId` upserts one server `Trip`; the server keeps running aggregates
  (distance via haversine, max speed, point count, last position).
- A point with `tripStatus: "ended"` / `"timed_out"` closes the trip.

On each ingest the freshest position per trip is emitted over Socket.IO
(`location` event) to `admins` and the owning `manager:<id>` room.

## curl smoke test

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"driver@jsan.local","password":"Driver@12345"}' | jq -r .token)

curl -s localhost:4000/api/tracking/ingest -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "points":[{"clientId":"p1","clientTripId":"t1","lat":17.41,"lon":78.44,
    "speedKmh":30,"recordedAt":"2026-07-08T10:00:00Z","tripStatus":"active"}]}'
```

## Notes / next passes
- **Pass 2 — mobile:** Expo app + a **dedicated Kotlin foreground-service module**
  (FusedLocationProvider + Activity-Recognition transitions + `BOOT_COMPLETED`),
  so tracking auto-starts at ≥5 km/h and survives the app being killed. SQLite buffers
  offline, then flushes to `/api/tracking/ingest`.
- **Pass 3 — admin panel:** React + react-leaflet (OSM) + Socket.IO live markers.
