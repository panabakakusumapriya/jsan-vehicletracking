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

### Seeding a real driver roster

`src/seed/seedDrivers.js` holds a roster (name / phone / email) and creates those drivers
against one manager. Edit the `ROSTER` array and run:

```bash
npm run seed:drivers -- --dry-run          # preview, writes nothing
npm run seed:drivers                       # create the missing ones
npm run seed:drivers -- --manager=boss@example.com --password=Other123
npm run seed:drivers -- --reset-passwords  # also reset EXISTING accounts to the default
```

Idempotent: accounts are matched on email, so a re-run creates nothing twice and only tops
up profile fields. Passwords are **not** touched on re-run unless `--reset-passwords` is
given — otherwise a routine re-seed would silently hand every account back to the shared
default after drivers had changed it. Phone numbers are normalised to `+<code><number>` and
`country` is inferred from the dialling code (only used by the live map's country filter).

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

### Assets & custody history  (admin, manager)
- `GET/POST /api/mobiles`, `GET/PATCH/DELETE /api/mobiles/:id` — device inventory
  (`GET /:id` also returns that handset's full custody history)
- `POST /api/assignments` `{ assetKind, assetId, driverId, startedAt?, note? }` — hand an
  asset over; closes the previous stint and opens a new one atomically
- `POST /api/assignments/:id/return` `{ endedAt?, note? }`
- `GET  /api/assignments?from&to&driverId&assetId&assetKind&open=true`
- `GET  /api/reports/custody?month=2026-06&tz=Australia/Sydney` — pivoted per driver + days
- `GET  /api/reports/custody.csv?month&tz`

Assignments are **intervals, not pointers**: reassigning a vehicle closes the old row and
opens a new one, so "who had what last month" survives. `User.vehicleId`,
`Vehicle.assignedDriverId` and `MobileDevice.currentDriverId` remain as caches of the open
row. Changing them through the existing Drivers/Vehicles screens goes through the ledger too,
so no assignment path bypasses history. Full rationale: `docs/asset-custody-design.md`.

```bash
npm run backfill:custody -- --dry-run   # preview importing today's assignments as history
npm run backfill:custody                # apply (idempotent, additive only)
npm run test:custody                    # 57 assertions: invariants, backdating, DST, scoping

npm run demo:custody                    # a 3-month story to walk someone through
npm run demo:custody -- --clean         # remove every trace of it
```

`demo:custody` builds two drivers, two vehicles and two handsets across May–July 2026 using
the real assign/return calls, so what appears on screen is the system working rather than
seeded rows. It prints a month-by-month table and a numbered walkthrough. Everything it
creates is tagged (`@jsan.demo` emails, `DEMO-` plates, `DEMO` IMEIs) so `--clean` removes it
exactly and can never touch real records.

### Weather  (admin, manager, team lead)
- `GET /api/weather/driving?day=0` — driving conditions per location, worst first.
  `day` is an offset in **local** days (0–4).

Answers "can today's driving happen", not "what's the weather". Every hour is scored against
thresholds that matter to a vehicle, and a day takes its **worst remaining** hour — a clear
morning doesn't cancel a dangerous evening.

| Verdict | Triggers |
|---|---|
| do not drive | thunderstorm · heavy rain/snow · anything freezing (rain, drizzle, fog) · violent showers · visibility < 1 km · gusts ≥ `WEATHER_GUST_UNSAFE_KMH` |
| caution | moderate rain · snow · fog · dense drizzle · visibility < 4 km · wind ≥ `WEATHER_WIND_CAUTION_KMH` · ≥ 60% chance of rain |

Defaults (40 / 60 km/h) are set for **high-sided vans**, which catch crosswind far worse than
cars. Raise both for a car-only fleet.

**No API keys.** Forecasts come from [Open-Meteo](https://open-meteo.com) (hourly, 5 days,
wind already in km/h); place names from OpenStreetMap Nominatim, cached permanently since the
town at a coordinate never changes.

> **Licensing:** Open-Meteo's free endpoint is licensed for **non-commercial** use; they sell
> a commercial plan on a different host. `WEATHER_API_BASE` exists so switching to it is one
> env var, not a code change. Nominatim requires an identifying `GEOCODER_USER_AGENT`.

Three things keep this cheap and correct:
- **Clustering + caching.** Drivers within ~25 km share one forecast, cached 30 min, so a
  depot of twenty costs one call per half hour rather than twenty per page load.
- **Local days.** "Today" uses each location's own UTC offset — a driver in Singapore and one
  in France don't share a today.
- **Hourly scoring, 3-hourly display.** All 24 hours are scored so a single bad hour is never
  missed; the strip shows 8 blocks, each carrying the worst hour inside it.

Positions come from each driver's most recent trip. Anyone without a trip in
`WEATHER_ACTIVE_DAYS` is listed as "no recent location" rather than being shown the weather
for a city they may have left. If the forecast service is unreachable, the last known forecast
is served tagged `stale` rather than an error page.

```bash
npm run test:weather            # 45 assertions: WMO codes, day logic, timezones, clustering
npm run test:weather:pipeline   # 20 assertions: clustering, caching, scoping, outage fallback
```

### Push / alerts  (admin, manager — used by the panel PWA)
- `GET  /api/push/public-key` (no auth) → `{ publicKey, configured, alertsEnabled }`
- `POST /api/push/subscribe` `{ endpoint, keys:{p256dh,auth} }` — idempotent by endpoint
- `POST /api/push/unsubscribe` `{ endpoint }`
- `POST /api/push/test` — fire a notification at your own devices (rate-limited 5/min)

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

## Driver-offline alerts

Ingest only runs when a device talks to us, so "this driver went silent" — the absence of
traffic — needs a clock, not a request. `services/driverWatchdog.js` sweeps every
`WATCHDOG_INTERVAL_SECONDS` (30s) and, for each **active** trip whose last heartbeat is
older than `DRIVER_OFFLINE_AFTER_SECONDS` (3 min, comfortably above the device's 30s
stationary keep-alive), raises an alert to the driver's manager **and** every admin:

- **Web Push** → lands on the installed admin-panel PWA even with every tab closed.
- **Socket.IO `alert` event** → in-app toast for panels that are open right now.

De-duping is a conditional update, not in-memory state: an alert is only sent by whoever
wins `Trip.offlineNotifiedAt: null -> now`, so a restart or a second instance can't re-send
it. The flag is cleared (and a "back online" alert sent, if `ALERT_ON_BACK_ONLINE`) as soon
as the device reports again. The same sweep also closes trips silent past
`SESSION_DEAD_AFTER_SECONDS`, so the live map self-heals even on days nobody opens it.

Set up push once:

```bash
npm run vapid     # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
```

Put **both** in the environment (locally and on Railway). Without them the watchdog still
runs and still emits socket alerts — only the "panel is closed" delivery is skipped.

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
