# Assigned-area coverage, in/out-of-polygon distance, and driver route history

**Date:** 2026-09-01
**Status:** approved for implementation (built autonomously from the product owner's spec; review the
result, not the plan)

## 1. What is being asked for

Three things, all stated by the product owner in one breath:

1. **The driver must see their complete route history on the phone**, not only the current or last
   trip, so they know where they have already been.
2. **When a driver has polygons assigned and drives outside them**, the distance must be split into
   *in-polygon* and *out-of-polygon* distance, both post-snapping.
3. **UKM depends on whether the driver has polygons assigned:**
   - assigned → UKM is measured **against the assigned road network** ("assigned-route UKM"), post
     snapping, with a *slight buffer* so a snapped route a few metres off a link still counts;
   - not assigned → UKM is the existing **global unique-km** over the whole snapped route.

This is a slice of `README_GLOBAL_UKM_END_GOAL_AND_IMPLEMENTATION.md` (EC-25 "driver goes outside
assigned polygon", and Phase 3 "canonical road attribution" for the *assigned* case). It is also
the missing piece the driver map has been waiting on: `LinkCoverage` had readers and no writer, so
every assigned road stayed red forever.

## 2. Current state (verified in code)

- `services/globalUkm.js` computes global UKM from snapped-vertex segment keys into
  `CoverageSegment`. Works, tested, unrelated to the customer road network.
- `models/LinkCoverage.js` is the per-network "first driver to cover this LINK_ID" ledger. The admin
  Coverage tab and `services/driverRoads.js` (the phone's red/blue roads) read it. **Nothing writes
  it.**
- `GET /api/tracking/my-session` returns only the active trip or the most recent one in 7 days.
- `AreaAssignment` is append-only with `assignedAt` / `releasedAt`, so "which polygons did this
  driver hold when this trip was driven" is answerable.
- `WorkArea.geometry` is the full polygon; `RoadLink.areaId` was resolved at import by spatial join.

## 3. Design

### 3.1 One new engine: `services/linkCoverage.js`

Runs after map-matching and after global attribution, for every closed, matched trip.

**Inputs:** `Trip.cleanedRouteShapes` (walked with `globalUkm.walkTrip`, which yields each polyline
step with its interpolated observation time), the active `NetworkVersion` for the trip's project,
and the driver's assignments *as they stood during the trip*.

**Step A — assignment at trip time** (`services/assignedAreas.js`)
`AreaAssignment` rows for the driver where `assignedAt <= trip.endedAt` and
(`releasedAt` is null or `releasedAt >= trip.startedAt`), resolved to `WorkArea`s in the active
version by `areaCode` (the customer's stable id — same rule as `myAreas` / `authoriseArea`). Returns
`{ networkVersionId, projectId, areas[] }` with full geometry, or `null` when the project has no
active network.

**Step B — in / out of polygon**
Every route step's midpoint is tested against the assigned polygons (full geometry, holes
respected). A point is "in" when inside any polygon **or within `AREA_BOUNDARY_BUFFER_METERS`
(default 20 m) of its boundary** — SA2 boundaries run down the middle of streets, and a driver on
the boundary street is doing their job. Sums become `inAreaMeters` / `outAreaMeters` (physical
snapped distance, repeats included). Out-of-area runs are encoded as polyline6 in `outAreaShapes`
so both maps can colour them. All three are `null` when the driver held no polygon.

**Step C — link matching with a buffer**
Candidate `RoadLink`s are loaded per ~3 km window of the route by `$geoIntersects` on the window's
padded bbox (never the whole trip bbox — a rural trip bbox can cover tens of thousands of links).
Each link is sampled every 8 m along its geometry; a sample is *hit* when some route step within
`LINK_COVER_BUFFER_METERS` (default 15 m) has a compatible heading:

| `dirTravel` | compatible when |
|---|---|
| `B` (both) | step bearing within `LINK_COVER_HEADING_MAX_DELTA_DEG` (60°) of the link bearing **or** its reverse |
| `F` | within 60° of the digitised direction |
| `T` | within 60° of the reverse |

A link is *covered* when `hits / samples >= LINK_COVER_MIN_FRACTION` (default 0.6). Its
observation time is the earliest hitting step's time. The heading rule is what keeps dual
carriageways apart (EC-09); the fraction is what stops an accidental 5 m touch claiming a 900 m
link (EC-30). `firstFraction` is stored for disputes.

**Step D — the claim** (mirrors `globalUkm.claimTrip`, keyed `(networkVersionId, linkId)`)
- unheld → upsert with `$setOnInsert` (the unique index is the lock);
- held by a *later* observation → take over, remember the displaced trip;
- held by an earlier one → `passes += 1` (guarded by `lastTripId` so re-runs don't double count);
- rows this trip owned but no longer covers (a re-match changed its route) → released.
Displaced trips get their link metrics recomputed.

**Step E — metrics**, persisted on the trip:

| field | meaning |
|---|---|
| `assignedAreaIds[]`, `assignedNetworkVersionId` | what the figures were measured against |
| `inAreaMeters`, `outAreaMeters`, `outAreaShapes[]` | Step B |
| `linkUkmMeters` | **assigned-route UKM**: length of links first-covered by this trip that lie in the driver's assigned areas |
| `linkUkmNetworkMeters` | same, any area of the network (admin insight: useful work outside the patch) |
| `linkUkmShapes[]` | geometry of the assigned links this trip first-covered (polyline6) |
| `linkCoveredCount` | links this trip touched (owned or repeat) |
| `linkCoverageStatus` | `pending` / `computed` / `review` / `no_network` / `failed` |
| `ukmBasis` | `assigned` when polygons were held (and a network exists), else `global` |
| `effectiveUkmMeters` | `linkUkmMeters` when basis is `assigned`, else `globalUniqueMeters` — **the driver-facing UKM** |

`ukmBasis` / `effectiveUkmMeters` are kept in sync by `services/ukmBasis.js`, called from both
engines, so reports can aggregate one field.

Eligibility reuses `globalUkm.eligibility`: a trip under the review ratio still claims links
(same `UKM_REVIEW_CLAIMS_COVERAGE` rule and reason — an unclaimed street would be paid twice) and
is stamped `review`. A trip that could not be matched keeps everything `null` — null is "not
established", never zero.

### 3.2 Pipeline wiring

`mapMatcher.processTrip`: match → `recomputeDriverUkm` → `attributeTrip` (global) →
**`attributeTripLinks`** (new). The tick's catch-up sweep gains a third clause for trips with
snapped geometry whose `linkCoverageComputedAt` is null or older than `mapMatchedAt`. All three are
independently non-fatal.

`seed/backfillLinkCoverage.js` (`npm run backfill:link-coverage [--version <id>] [--dry-run]`)
replays every active network version: clear its ledger, claim trips oldest-first, then measure —
two passes for the same reason `rebuildScope` has two.

### 3.3 Driver history on the phone

`GET /api/tracking/my-history?days=N` (driver only, default 30, max 180, gzipped like `my-roads`,
own rate limiter). Returns closed trips in the window (the active trip is the live trace, not
history):

```
{ days, from, version, truncated,
  totals: { trips, distanceMeters, cleanedMeters, inAreaMeters, outAreaMeters, ukmMeters },
  trips: [{ id, startedAt, endedAt, status, kind: 'snapped'|'raw',
            shapes[], outAreaShapes[], distanceMeters, cleanedDistanceMeters,
            inAreaMeters, outAreaMeters, ukmMeters, ukmBasis, ukmStatus }] }
```

Snapped trips ship `cleanedRouteShapes` simplified at 10 m; unmatched trips ship their raw trace
simplified at 15 m (limited to the 20 most recent such trips — they are rare and heavy). Total
vertices are capped at 400k, dropping oldest trips first and setting `truncated`. `version` is
`count.maxUpdatedAtMs` so the app can skip a redraw when nothing changed.

App: `roadCache.getHistory()` (disk envelope per window, 10 min max age, last-good-copy on
failure); MapGL gets a `history` source pushed over its own bridge call (never on the 15 s trace
tick — it is megabytes), drawn **grey** under everything; the current trip's out-of-area runs are
drawn **orange** over the green trace. Layers panel gains **History: Off / 7 d / 30 d / 90 d**.
Stats strip shows, for the current trip, *In area / Outside / UKM (assigned|global)*, and a history
line *"Last 30 d: 412 km driven · 210 km UKM"*. Roads are force-refreshed when the current trip
flips to `matched` (that is exactly when links turn blue). `signOut` now clears the road/history
cache and map prefs — the shared-handset leak the cache module documented but never wired.

### 3.4 Admin panel

`TripDetail` (Snapped mode): tiles *In area / Outside area* when the trip had polygons, the UKM
tile shows `effectiveUkmMeters` with an `assigned roads` / `global` badge and, when assigned, the
global figure as a secondary line; out-of-area stretches are drawn orange on the map with a legend
entry. `Trips` inner rows gain *UKM* and *Outside area* columns. The Coverage tab's covered-km and
% complete populate automatically once the ledger has a writer.

### 3.5 Configuration (all in `config/env.js`, all overridable)

`LINK_COVERAGE_ENABLED=true`, `LINK_COVER_BUFFER_METERS=15`, `LINK_COVER_MIN_FRACTION=0.6`,
`LINK_COVER_HEADING_MAX_DELTA_DEG=60`, `AREA_BOUNDARY_BUFFER_METERS=20`,
`MY_HISTORY_DEFAULT_DAYS=30`, `MY_HISTORY_MAX_DAYS=180`.

## 4. Alternatives considered

- **Split RoadLinks into 5–10 m atoms (README Option B).** Exact partial-link credit, but new
  collection, new index, and a rewrite of every LinkCoverage reader. Whole-link with a 60 %
  threshold and stored fraction is a documented tolerance on 94 m average links; atoms remain the
  next phase.
- **Buffer the polygon instead of the point.** Needs a geometry library the backend does not have;
  point-to-ring distance is a few hundred lines less and equivalent for this purpose.
- **History via `my-session` returning N trips.** Would put megabytes on the 15 s poll. A separate,
  cached, rarely-polled endpoint is the only shape that survives the fleet's data budget.

## 5. Testing

`test/linkCoverage.test.js` on mongodb-memory-server, same style as `globalUkm.test.js`, with a
synthetic 3-link network and one polygon:

- A: assigned driver drives the whole polygon → all links claimed, `linkUkmMeters` = network length,
  `outAreaMeters` = 0, basis `assigned`, driver map's `getDriverRoads` shows them covered.
- B: second driver later drives the same links → 0 assigned UKM, `passes` incremented, first owner
  unchanged.
- C: route leaves the polygon → in/out split matches geometry; out-of-area link counts toward
  `linkUkmNetworkMeters` but not `linkUkmMeters`.
- D: a 5 m graze of a link does not claim it (fraction threshold).
- E: one-way link driven against `dirTravel` is not claimed (heading gate).
- F: unassigned driver → basis `global`, `effectiveUkmMeters` = `globalUniqueMeters`, in/out null.
- G: earlier-observed late upload takes the link back (takeover) and the displaced trip drops to 0.
- H: re-attribution after the route changed releases links it no longer covers.
- I: `rebuildNetworkCoverage` reproduces the incremental result.

## 6. Out of scope (explicitly)

Partial-link intervals; reports/CSV columns for the new fields; global UKM moving to RoadLink
identity; tapping a road on the phone for audit info.
