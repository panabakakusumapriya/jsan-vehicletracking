# Global UKM — what was built, how to switch it on, and what is still open

Implements `README_GLOBAL_UKM_END_GOAL_AND_IMPLEMENTATION.md`. That document is the specification;
this one is the record of what the code now does, so the two can be read side by side.

**The defect it fixes.** Every UKM path in this repository deduplicated road *per driver*.
`roadSegments.js` built its `seen` set from `Trip.find({ driverId })`; `UkmEdge` was keyed
`(edgeKey, driverId)`. Both are correct answers to *"am I repeating myself"* and wrong answers to
*"did the fleet already drive this"*. Driver 101 covering a street under Project A left Driver 201
free to be credited for the same street under Project B. There is now one ledger row per piece of
road per coverage scope, so the second driver over a street cannot find it unclaimed.

---

## Turning it on

It is on by default (`GLOBAL_UKM_ENABLED=true`). To populate historical data:

```bash
cd backend
npm run backfill:global-ukm -- --dry-run   # report only, writes nothing
npm run backfill:global-ukm                # stamp scopes, then rebuild every scope
```

The job **writes only derived data**: `CoverageSegment` rows and the UKM fields on `Trip`. Raw GPS
(`LocationPoint`, `RejectedPoint`), route geometry, raw and cleaned distances, the legacy
`ukmMeters` / `ukmWithinTripMeters` / `ukmNewShapes` figures and the whole `UkmEdge` collection are
never touched. Re-running is free and produces the same answer.

The map-match worker also attributes each trip inline as it is matched, and carries a catch-up
sweep for trips that were matched before this feature existed — so an untouched deployment fills in
on its own; the job above just makes it happen now instead of over the next few hours.

## The business rules, as configuration

All in `backend/src/config/env.js`, deliberately not buried as constants — each one changes what a
customer is invoiced for:

| Variable | Default | What it decides |
|---|---|---|
| `GLOBAL_UKM_ENABLED` | `true` | Master switch. Off = nothing is written and the legacy figures stand. |
| `UKM_DEFAULT_COVERAGE_SCOPE` | `DEFAULT` | The dedup universe a project falls into when it has no explicit scope — i.e. all of them today, so everything deduplicates against everything. |
| `UKM_ALGORITHM_VERSION` | `global-segment-1` | Stamped on every trip. Bump it and the worker re-attributes trips left behind by the old build. |
| `UKM_REVIEW_MATCHED_RATIO` | `0.9` | Below this snapped fraction a trip is flagged `review`. |
| `UKM_REVIEW_CLAIMS_COVERAGE` | `true` | Whether a `review` trip still claims the road it covered. True, because *not* claiming leaves the road unclaimed and pays the **next** driver for it. |
| `UKM_DIRECTION_IS_SAME_ROAD` | `true` | A → B and B → A are the same coverage. Recorded; see Open items. |

## Coverage scopes

A project's scope is `Project.coverageScopeId`, falling back to the default. **One shared default
is the requirement, not a shortcut** — the rule being implemented is literally "Driver 201 must not
be credited under Project B for a road Driver 101 covered under Project A". Giving a project its
own scope *creates* duplicate billable road by definition, so it is an explicit act, editable per
project on the Projects page.

Every new trip is stamped with its scope at start, like `projectId` and `timezone` and for the same
reason: moving a project into another scope next year must not re-price roads already invoiced.

---

## What was built

**New**

| File | What it is |
|---|---|
| `backend/src/models/CoverageSegment.js` | The global ledger. Unique on `(coverageScopeId, coverageCycleId, segmentKey)` — one row per piece of road, owned by whoever reached it first. |
| `backend/src/services/globalUkm.js` | The engine: walk the snapped route → union within the trip → claim against the ledger → persist figures and map geometry. |
| `backend/src/services/coverageScope.js` | Resolves a trip's dedup universe. |
| `backend/src/seed/backfillGlobalUkm.js` | The explicit migration/rebuild job. |
| `backend/test/globalUkm.test.js` | 51 assertions, acceptance cases below. |

**Changed**

- `Trip` — additive fields: `coverageScopeId`, `coverageCycleId`, `ukmStatus`,
  `distinctRoadMeters`, `sameTripRepeatMeters`, `historicalDuplicateMeters`, `globalUniqueMeters`,
  `unmatchedReviewMeters`, `ukmUniqueShapes`, `ukmDuplicateShapes`, `globalUkmComputedAt`,
  `ukmAlgorithmVersion`. Nothing removed.
- `Project` — `coverageScopeId`, `coverageCycleId`.
- `mapMatcher.js` — attributes each trip to its scope after matching, plus a catch-up sweep.
  `recomputeDriverUkm` still runs; the two answer different questions.
- `tracking.controller.js` — `/ukm`, `/ukm-driver`, `/ukm-export` now read the persisted figures.
- `Ukm.tsx`, `TripDetail.tsx`, `Projects.tsx` — render the backend's verdict; no client-side UKM.
- KML/CSV exports read the same fields the dashboard does.

### Ownership is decided by observation time

Not upload time, not trip start. Each segment carries its own observation time, interpolated along
the snapped route between `startedAt` and `endedAt`. So:

- a trip that syncs eight hours late still owns the road it drove first — and **takes it back**
  from the trip that provisionally claimed it, whose figures are then recomputed;
- a trip that started at 08:00 does not own a road it did not reach until 11:00.

Ties break on `firstAt`, then `tripId` — deterministic, so two workers racing converge on the same
owner rather than letting whichever write landed first decide who gets paid.

### API changes

- `POST /api/tracking/ukm-backfill` → **`POST /api/tracking/ukm-rebuild`** (admin). The old
  endpoint ran the legacy `UkmEdge` migration.
- **Removed: the hidden migration on `GET /ukm`.** That endpoint carried a one-shot block that
  dropped an index, recreated `UkmEdge` and backfilled the fleet on whichever request arrived first
  after a restart. A dashboard read does not get to migrate the database.
- `GET /api/tracking/ukm` now returns `distinctKm`, `duplicateKm`, `pendingTrips`, `reviewTrips`
  and a full per-driver breakdown. **`overlapPct` changed meaning**: it is now duplicate ÷ distinct
  road, not `1 − unique/raw`. The old ratio divided a date-ranged raw distance by a driver's
  *lifetime* `UkmEdge` total — a one-day report could show 40 km driven and 900 km unique.
- `GET /api/tracking/ukm-export` accepts `?rows=trip` for auditable per-trip rows.

### `0` and `null` are different answers

`0` means *processed, and none of it was new road* — a valid, common result. `null` means *not
established*. Trips with no figure are counted and surfaced separately in the UI and CSV rather
than folded into the totals as zeros.

---

## Checking old vs new

```bash
cd backend
npm run compare:ukm                 # fleet + per-driver, old beside new
npm run compare:ukm -- --trips 30   # also list the trips that disagree most
```

Read-only; it writes nothing. It prints four things, in this order:

1. **Has the new engine run at all** — trip counts with an old figure vs a new one, and the ledger
   size. If the new column is 0, the page is still showing you old numbers and you need
   `npm run backfill:global-ukm`.
2. **Fleet totals** over only the trips carrying *both* figures, so it is like-for-like.
   `old − new` is the headline: road a driver had not personally driven but somebody else already
   had — exactly what the old logic credited twice. It cannot be negative.
3. **Whether this fleet overlaps at all** — how many ledger segments a second, *different* driver
   came back to.
4. **Per driver**, with a `Lost km` column, and optionally the worst individual trips by trip id.

`Trip.ukmMeters` (old) and `Trip.globalUniqueMeters` (new) use the *same* road identity, so the
difference between them is real, not measurement noise. `UkmEdge` is shown for reference only — it
uses raw ~11 m GPS grid cells rather than snapped geometry and is a lifetime total, so it is **not**
comparable metre-for-metre with either.

### If the two numbers are identical

That is a valid result, not a sign the new logic is inert. It means no driver was credited for road
another driver had already covered — which is exactly what you get when **drivers work disjoint
areas**, the usual case for an area-assigned fleet. Section 3 of the report is the check: if
cross-driver segments is 0, there was no double counting to remove and both logics must agree.

To see the mechanism work without waiting for two crews to meet, run `npm run test:global-ukm` — it
drives the cross-driver, cross-project and nested-overlap cases directly.

### Where to look in the UI

- **/ukm** — `Distinct KM`, `Already Covered` and `Unsettled` columns are new. `UKM` is now the
  global figure. `Overlap` changed meaning: duplicate ÷ distinct road, not `1 − unique/raw`.
- **Trip detail** — the UKM tile carries a badge reading `global` or `per-driver`, so you can tell
  at a glance which definition produced the number, plus an `Already covered` tile beside it.
- **CSV** — `GET /api/tracking/ukm-export?rows=trip` has both figures per trip: `Unique KM` (global)
  and `Legacy Per-Driver UKM`.

## Acceptance tests

`npm run test:global-ukm` — 51 assertions. Including the mandatory business example, which prints:

```
── Test D: MANDATORY — 12 km + nested 4 km history, 3 km self-repeat, 30 km driven ──
   → distinct 27 km, duplicate 12 km, UKM 15 km
```

The 4 km does **not** add to history because it sits inside the 12 km. Covered, mapped to the
spec's own labels: A (same driver repeat), B (cross-driver), C (cross-project) and C2 (separate
scopes stay separate), D (nested overlap), E (partial overlap), H (late offline upload takes
ownership back), I (trip starts earlier, arrives later), L (partial match flagged), M (invalidated
first-cover trip hands the road on), P (rebuild reproduces the incremental result exactly), plus
EC-04 self-repeat, EC-16 null-vs-zero, the shapes-match-the-numbers check, and the reconciliation
invariants — `distinct = duplicate + unique`, no negative metres, no segment with two owners.

---

## Open items

Two pieces of the specification are **not** implemented, and both are worth knowing about before
this is treated as contractual.

**1. Canonical road identity (spec §9, Phase 3).** Road identity is still the snapped-polyline
endpoint pair — the same `segmentKey` the per-trip figures have used successfully — not a
`RoadLink` id plus along-link measures. Snapped vertices are stable enough that a second pass over
a street returns the same key, so cross-driver dedup works. What they cannot express is *"Driver
101 covered metres 0–600 of this link, Driver 201 later covered 400–1000"* where the two matches
returned different vertices for the same physical road; that case can still over-credit at the
boundary. Building it properly needs link snapping with topology and direction, and it only applies
where a customer network has been imported — most trips have no `projectId` at all today.
`segmentKey` is an opaque string in the ledger specifically so this can change without a migration.

**2. Per-segment unmatched geometry (spec EC-15).** `unmatchedReviewMeters` is derived from the
trip-level `cleanedMatchedRatio`, so it says *how much* of a trip was raw-GPS fallback but not
*where*. Isolating the exact stretches needs the matcher to record per-shape provenance, which
`valhalla.js` does not currently keep. Until then a partly-unmatched trip is flagged `review` and
still claims its road — see `UKM_REVIEW_CLAIMS_COVERAGE` for why claiming is the safer default.

Also deferred, as the spec allows: `UKM_DIRECTION_IS_SAME_ROAD` is read and recorded but cannot yet
be set to `false` — segment keys are direction-free by construction. Imagery-gated
`acceptedCaptureUkm` (spec §3.7, EC-38) is not built; unique *driven* road is not silently equated
with valid *captured* road, it simply is not modelled.

## Deprecated, not deleted

`UkmEdge` still receives writes on trip completion so old and new figures can be compared during
cutover, but nothing reads it for a business number. `recomputeDriverUkm` still runs and its
per-driver figures still appear (labelled `per-driver` on the trip page) — they answer a real
question. Retire either only after a side-by-side sign-off.
