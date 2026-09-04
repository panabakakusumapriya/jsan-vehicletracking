# Bugs — Scoring Rubric & Stabilization Ledger

The driver map is the product: a driver at 50–80 km/h must always know **where they are, where
they have driven, and what is left** — with no stuck dot, no frozen line, no silent failure.
Every bug below was found by code review of the live-map path (mobile `map.tsx`, `MapGL.tsx`,
`TrackingService.kt`, `Uploader.kt`; backend `tracking.controller.js`, `tripLifecycle.js`,
`driverWatchdog.js`, `marker.controller.js`) and is scored with the rubric before being fixed
or deliberately deferred.

## Scoring model

**Score = Severity × Likelihood** (each 1–5).

| Severity | Meaning (this system) |
|---|---|
| 5 | Field data lost, or the driver acts on wrong information (redoes/skips roads) |
| 4 | Core screen unusable or frozen for a shift; silent stop of tracking/uploads |
| 3 | Degraded but recoverable (lag, stale banner, wasted battery/data) |
| 2 | Cosmetic wrongness a user can see through |
| 1 | Latent only — needs another change to become visible |

| Likelihood | Meaning |
|---|---|
| 5 | Every shift, every driver |
| 4 | Most shifts, or any driver in weak-signal areas (our normal terrain) |
| 3 | Regular occurrence fleet-wide (weekly) |
| 2 | Needs an unusual-but-real combination (second handset, clock jump) |
| 1 | Requires a future code change or rare device behaviour |

**Priority bands:** P0 ≥ 16 (fix before anything ships) · P1 10–15 (fix this cycle) ·
P2 5–9 (fix when touching the area) · P3 ≤ 4 (record, revisit).

**Rules.** A bug enters the ledger only with a concrete failure scenario (inputs → wrong
outcome). "Fixed" requires the fix applied *and* type/syntax checks passing; visual/field
behaviour still needs a device pass, marked ⏳ where pending. Deferred bugs carry a reason,
not just a status.

---

## Ledger

### Fixed — live-drawing / stuck-map pass (2026-09-04)

| # | Bug | Sev | Lik | Score | Fix |
|---|-----|-----|-----|-------|-----|
| 1 | **Route line only drew after upload + DB + 15 s poll round trip** — in weak signal the driver saw no line for minutes and could not tell driven from undriven road (the core complaint: redoing completed streets) | 5 | 4 | **20 · P0** | Local live breadcrumb: the map draws each fix from the service directly (`trail` channel, 12 m gate, bounded 600 pts); server trace overdraws as uploads catch up |
| 2 | **No true "go to my location"** — recenter used the last vehicle point the *page* knew; with no fix it jumped to the allocation extent, potentially hours away | 3 | 4 | **12 · P1** | ◎ button now: fresh native fix → fly there; else one-shot GPS; else old recenter fallback (`flyTo` command added to MapGL) |
| 3 | **No max trip duration** — a forgotten session ran forever: never snapped, never recoloured roads, next shift started confused | 4 | 3 | **12 · P1** | 8 h cap on BOTH sides: device (`TRIP_MAX_DURATION_MS`, monotonic check in tick, cleared on end) and server watchdog (`closeOverlongTrips`, env `TRIP_MAX_DURATION_HOURS`). Closed as **`completed`**, deliberately: the ingest revive path only reopens `timed_out`, so the close sticks under old builds still streaming — and the matcher sweeps completed+pending, so snapping starts on its next tick with no extra wiring |
| 4 | **Dead token read as a network hiccup** — my-session 401 showed "Session request failed (401)" and the driver waited out a session that would never return | 4 | 2 | **8 · P2** | 401 now reads "Session expired — sign out and sign in again." (full auto-signout via the shared request layer is deferred — see D3) |

### Fixed — earlier passes of this same stabilization (context)

| # | Bug | Score | Fix |
|---|-----|-------|-----|
| 5 | Dot fed by server round trip; froze on upload stall / trip-start gate / stale token | 20 · P0 | Dot rides the phone's own GPS; idle fixes emitted pre-trip |
| 6 | Native service kept a superseded token forever (`started` guard); uploads 401'd, points piled up | 16 · P0 | Token follows re-login, guarded against blank config & double-configure |
| 7 | `liveFix` shadowed server points forever (second handset showed the *viewer*, dead service froze the dot) | 12 · P1 | 90 s freshness TTL; stale local yields to server points |
| 8 | Marker drop used the stale display position — flagged yesterday's endpoint | 12 · P1 | Placement mode: pin = map centre; fallback one-shot GPS read at drop time |
| 9 | Parked phone re-rendered whole screen + WebView every 5 s (identical fixes) | 9 · P2 | Coordinate dedupe on both screens |
| 10 | Upload-error banners never expired / never appeared where drivers look | 9 · P2 | 90 s self-re-arming expiry on home + map screens |
| 11 | Vehicle updates re-injected the whole trace payload every tick | 8 · P2 | Dot got its own bridge channel (`__mapglVehicle`); trail/markers/history each version-keyed |
| 12 | Idle-emit throttle on wall clock — a backwards NTP jump silenced the dot | 6 · P2 | `elapsedRealtime()` |
| 13 | Idle emit hand-built the event payload; zero-timestamp fixes became 1970 | 2 · P3 | Reuses `locMap()` and its guard |

### Open — deferred, with reasons

| # | Bug / anomaly | Sev | Lik | Score | Why deferred |
|---|-----|-----|-----|-------|--------------|
| D1 | Marker outbox drops entries on any error whose message matches `/category/i` — string-matching server text is brittle | 3 | 2 | 6 · P2 | Needs a typed error contract from `request()`; touch when the API layer is next open |
| D2 | `onLocation` overloaded with idle fixes — every future subscriber must know to filter `tripStatus` | 1 | 3 | 3 · P3 | Separate `onIdleLocation` event = native + JS API change; batch with next native release |
| D3 | Map screen's session poll bypasses the global 401 signout (raw `fetch`) — mitigated by #4's clear message | 3 | 2 | 6 · P2 | Routing through `request()` changes error copy/paths on the most-load-bearing screen; do it with a device test in hand |
| D4 | Token-follow effect lives in `home.tsx`, works only while that screen mounts on re-login (true today via login flow) | 4 | 1 | 4 · P3 | Proper home is `auth.tsx`; move when auth is next touched |
| D5 | While driving, each appended trail point re-renders the map screen (~every 12 m). Acceptable measured cost; imperative injection would zero it | 2 | 4 | 8 · P2 | `MapGLHandle`-based push is the follow-up if low-end handsets show jank in the field |
| D6 | Teammate's `config.ts` on the other machine defaults `DEFAULT_API_URL` to their LAN IP — an APK built there ships pointing at a dead address | 4 | 2 | 8 · P2 | Fixed in this working tree (production default restored); the other clone needs the same — flagged to the team |
| D7 | Trips force-closed at 8 h keep receiving points from old-build devices into a closed trip (appended to history, not live) until those devices update | 2 | 2 | 4 · P3 | Self-resolves when the build with the device-side cap rolls out |

### Known-good behaviours confirmed while reviewing (not bugs)

- **Post-session snapping already displays correctly**: `resolveTrace` swaps the dashed raw
  line for the solid snapped route when `mapMatchStatus` flips to `matched`; roads recolour
  blue after link attribution; both are force-refreshed by the poll's transition detector —
  so the *next* session opens with the previous drive snapped and painted, exactly the
  "don't redo covered roads" requirement.
- The revive path (`timed_out` → `active`) correctly resets every derived figure; the 8 h
  close intentionally routes around it via `completed`.
- Trail clears on trip end and on trip-id change; idle fixes never draw lines.

---

*Update discipline: new bug → score it here first; fix → move rows up with the fix note;
never delete a row. The score decides order, not whoever shouted last.*

---

**Addendum (native-engine pass, same day):** WebView engine (MapGL.tsx) removed — MapNative is the sole engine, Expo Go shows a build-needed notice. New fix found in the map.tsx deep review: placement mode could drop a marker at a stale camera position when confirmed without panning (programmatic recentre fires no camera event in the native engine) — beginPlacing now seeds the camera ref with the fresh fix it flies to. Sev 4 × Lik 2 = 8 · P2, fixed.
