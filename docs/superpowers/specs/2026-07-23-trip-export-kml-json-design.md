# Trip Export (KML / JSON) — Design

## Goal

Let ops download recorded trip data in two open, portable formats: KML (for
viewing/replaying the drive in tools like Google Earth) and JSON (raw data
for other tooling). Two entry points: a day-wise/bulk export from the Trips
list, and a single-trip export from the trip replay page.

## Scope

**In scope:**

- `GET /api/trips/:id/export?format=kml|json` — single trip, backend.
- `GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=`
  — day-wise/bulk, backend. Returns a `.zip` of per-trip files.
- `backend/src/utils/tripExport.js` — shared `buildKml(trip, points)` /
  `buildJson(trip, points)`, used by both endpoints.
- `admin-panel/src/pages/TripDetail.tsx` — "Export KML" / "Export JSON"
  buttons for the current trip.
- `admin-panel/src/pages/Trips.tsx` — "Export KML" / "Export JSON" buttons
  that export everything matching the current filters.

**Out of scope:** the mobile app, and any scheduled/automatic export (this
is on-demand, button-triggered only).

## Backend

### Shared builder (`backend/src/utils/tripExport.js`)

- `buildKml(trip, points)` — a KML `Document`:
  - `name`: driver name + trip date; `description`: distance / duration /
    max speed / vehicle plate.
  - One `Placemark` with a `gx:Track`: a `when` + `gx:coord` pair per
    recorded point, using each point's *real* `recordedAt` timestamp and
    `lat/lon` — not resampled or simplified. This is what lets Google Earth
    replay the drive on its native time-slider, matching "exactly as it
    happened".
  - Separate Start / End point `Placemark`s.
  - Trips with 0–1 points: still valid KML, just without a `gx:Track` (only
    point placemarks) — no crash.
- `buildJson(trip, points)` — `{ trip: {driverName, vehiclePlate, status,
  startedAt, endedAt, distanceMeters, maxSpeedKmh}, points: [{lat, lon,
  speedKmh, heading, recordedAt}, ...] }`.
- Both take already-fetched Mongoose docs/plain objects; no DB access inside
  the builder module itself (keeps it independently testable and reusable).

### `GET /api/trips/:id/export?format=kml|json`

- Same lookup + `accessibleDriverFilter(req.user)` scoping as the existing
  `getOne` — a manager can't export a trip outside their scope.
- Fetches the trip's points (same query as `getOne`'s `?points=true` path),
  runs them through the matching builder, and returns the file directly with
  `Content-Type` (`application/vnd.google-earth.kml+xml` or
  `application/json`) and `Content-Disposition: attachment; filename=...`.
- 404s the same way `getOne` does for a missing/out-of-scope trip ID.

### `GET /api/trips/export?format=kml|json&status=&driverId=&driverIds=&from=&to=`

- Same `accessibleDriverFilter` scope as the existing `list`, plus the same
  `status` / `driverId` / `from` / `to` filters. Adds `driverIds` (a
  comma-separated list) for the case where the Trips page has a country
  filter active without a specific driver selected — see the frontend
  section below for why.
- Ignores pagination entirely (no `limit`/`page`) — every matching trip is
  included, not just what's on the current table page.
- Queries all matching trips + each one's points, builds a KML and JSON file
  per trip via the shared builders, and streams them into a `.zip` (using
  `archiver`) named `trips_<from>_<to>.zip` (or `trips_all.zip` if no date
  range), with entries named `trip_<driverName>_<startedAt>.kml` / `.json`.

## Frontend

### Auth / download mechanism (applies to both pages)

This app authenticates via a Bearer token attached in JS (`api.ts`'s
`request()`), not cookies — so a plain `<a href="...">` won't carry the
token. Both export buttons call the endpoint with an authenticated `fetch`,
read the response as a `Blob`, then trigger the download via a temporary
`URL.createObjectURL` link (create, click, revoke) rather than a direct href.

### `Trips.tsx` (day-wise / bulk)

- Two buttons, "Export KML" / "Export JSON", in the existing filter bar next
  to "Clear". Disabled when `filteredTrips.length === 0`.
- Builds the request from current filter state: `status`, `from`, `to`, and
  either `driverId` (a specific driver selected) or `driverIds` (computed
  from the existing client-side `countryDriverIds` set, when only a country
  is selected) — so export always matches exactly what the table shows,
  including the country filter that today is client-side only.
- Shows a brief disabled/spinner state on the clicked button while the
  request is in flight (a day with many trips means the backend gathers
  every matching trip's points before zipping).

### `TripDetail.tsx` (single trip)

- Two buttons, "Export KML" / "Export JSON", next to "← Back to trips".
  Downloads just the current trip, no zip.

## Error handling

- 0–1 point trips still export validly (see KML builder above).
- Missing/out-of-scope trip ID → 404, matching existing endpoint behavior.
- Client-side fetch/Blob failure → a small inline error near the export
  buttons, not a silent no-op.

## Testing

No test runner exists in this repo. Verification is manual: run both
servers, click every export button on both pages, open the resulting KML in
a KML viewer (confirm the time-slider replay matches the recorded route) and
the JSON in a text editor.
