# JSAN Vehicle Tracking — Global Unique Kilometres (UKM)
## End Goal, Current-State Review, Edge Cases, Technical Design, Migration and Acceptance Criteria

**Repository reviewed:** `jsan-vehicletracking` from the uploaded ZIP  
**Purpose of this document:** Give the development team one unambiguous specification for calculating **correct Unique Kilometres (UKM)** across every driver, every relevant project and all historical trips, while preserving auditability and preventing double counting.

---

# 1. Executive Summary

The business problem is not simply “how far did a driver travel?” It is:

> **For each driver/trip/day, how many kilometres of valid road did that driver cover that had never already been covered by any earlier eligible driver/trip in the same coverage programme — including the current driver's own previous trips — after removing repeated portions within the current trip?**

The current repository already has important building blocks:

- raw GPS trip capture;
- driver ID, trip ID, project ID and timestamps;
- offline/idempotent trip ingestion;
- Valhalla map matching;
- cleaned/snapped route geometry;
- per-trip same-driver UKM logic;
- an older raw-GPS `UkmEdge` implementation;
- road-network models (`RoadLink`, `NetworkVersion`);
- a `LinkCoverage` model that already expresses the important idea that **the first driver covering a road should own the credit**.

However, the current production UKM paths do **not** yet implement the requested metric correctly.

The most important gaps are:

1. `roadSegments.js` compares a trip only against **earlier trips of the same driver**.
2. `UkmEdge` stores uniqueness by `(edgeKey, driverId)`, so the same road can be “unique” separately for Driver 101 and Driver 201.
3. The `/ukm` dashboard can produce a fleet-level de-duplicated total, but the **per-driver UKM remains per-driver**, so it cannot correctly assign first-coverage ownership between drivers.
4. The date-filtered `/ukm` API obtains raw distance from trips in the selected date range but aggregates `UkmEdge` by driver without restricting those edges to the same selected trips/date range. This can mix **date-range raw KM with lifetime unique KM**.
5. The UKM map page re-derives “unique” geometry in the browser using a different ~11 m grid algorithm, so the visual line can disagree with the backend number.
6. Current per-trip snapped-route segment identity depends on exact snapped polyline vertex pairs. That is better than raw GPS, but it is not strong enough for contractual/global UKM because the same physical road can be returned with different vertices, chunk boundaries or partial extents.
7. Exact same-day/cross-driver ownership requires the time when a driver reached each road section, not only the trip start time.
8. Partially unmatched/synthetic gap-filled geometry must not silently receive the same UKM credit as confidently map-matched road geometry.

The final design should therefore use a **shared coverage universe** and a **canonical road-section identity**.

The definitive conceptual formula is:

```text
CurrentDistinctCoverage = UNION(all eligible road portions driven in the current trip)
HistoricalCoverage      = UNION(all eligible road portions covered before those portions were driven)
UniqueCoverage          = CurrentDistinctCoverage - HistoricalCoverage
UniqueKM                = LENGTH(UniqueCoverage) / 1000
```

The critical word is **UNION**. Historical overlaps must be merged before subtraction. Never add overlaps driver by driver.

---

# 2. Business Scenario

A large geographic area is divided into multiple operational projects. Each project has multiple drivers/cars. Drivers travel through their assigned area and capture images of houses.

For every ride/trip the system should know, at minimum:

- `driverId`
- `tripId`
- `projectId`
- coverage programme / scope
- vehicle ID where available
- trip date/time
- GPS coordinates
- raw travel distance
- cleaned/map-matched distance
- distinct road distance in the current trip
- historical duplicate distance
- unique distance
- map-matching/quality status
- optional imagery/capture quality status

The uniqueness test is **not confined to the driver's project**.

Example:

```text
Project A -> Driver 101
Project B -> Driver 201
Project C -> Driver 301
```

If Driver 101 previously covered a road under Project A, Driver 201 must not receive new/unique credit for the same road under Project B when both projects belong to the same coverage programme.

Likewise, Driver 301 must not receive new credit for a road Driver 301 personally covered last week/month/year.

---

# 3. Exact Definition of the Metrics

Do not use one ambiguous “KM” value. Persist and report separate metrics.

## 3.1 Physical / Raw Travel KM

Everything the device says the vehicle physically travelled.

```text
rawTravelKm = raw GPS accumulated distance
```

This can include:

- loops;
- U-turns;
- repeated roads;
- roads already driven by someone else;
- GPS noise;
- potentially poor-quality/unmatched portions.

Raw KM is useful operationally but is **not UKM**.

## 3.2 Cleaned / Matched Travel KM

Distance after map matching to the road network.

```text
cleanedTravelKm
```

This removes much of the GPS wandering/noise and should remain distinct from the raw number.

## 3.3 Current-Trip Distinct KM

Road coverage in the current trip after removing repeats inside the same trip.

If a driver drives Street A three times during one trip, Street A contributes once to distinct coverage.

```text
currentDistinctCoverage = UNION(current trip road coverage)
distinctKm = LENGTH(currentDistinctCoverage)
```

## 3.4 Historical Duplicate KM

The portion of the current trip's **distinct** road coverage that was already covered before the current traversal by any eligible driver/trip in the same coverage scope.

```text
historicalDuplicateCoverage = INTERSECTION(currentDistinctCoverage, historicalCoverage)
duplicateKm = LENGTH(historicalDuplicateCoverage)
```

## 3.5 Global Unique KM — the required UKM

```text
uniqueCoverage = currentDistinctCoverage - historicalCoverage
uniqueKm = LENGTH(uniqueCoverage)
```

This is the requested metric.

## 3.6 Unmatched / Review KM

Road/travel distance for which the system cannot confidently establish canonical road identity.

```text
unmatchedKm
```

This should be **NULL/REVIEW**, not automatically treated as unique.

## 3.7 Optional Accepted/Billable UKM

Because the purpose of driving is to capture house imagery, there is an important distinction:

```text
Unique Driven KM != necessarily Valid Captured KM
```

If the commercial/customer metric requires successful imagery, then:

```text
acceptedUkm = globally unique road coverage
              AND valid map match
              AND valid project/road scope
              AND required image/camera evidence exists
              AND QA passed
```

If image validation is not part of the UKM contract, keep this as a future metric. Do not silently equate it with unique driven KM.

---

# 4. The Critical 12 KM + 4 KM Example

This example must become a permanent automated regression test.

Historical/current facts:

```text
Driver 101 overlap with Driver 301's current route = 12 km
Driver 201 overlap with Driver 301's current route =  4 km
Driver 301 repeats 3 km inside today's own trip      =  3 km
Driver 301 physically travels                        = 30 km
```

Assume Driver 201's full 4 km is already contained inside Driver 101's 12 km.

Wrong calculation:

```text
historical duplicate = 12 + 4 = 16 km   <-- WRONG
```

Correct historical union:

```text
UNION(Driver 101 coverage, Driver 201 coverage) = 12 km
```

The 4 km does not add anything new to historical coverage because it is already inside Driver 101's road coverage.

Current-trip repetition is also unioned, not simply subtracted blindly:

```text
Physical current travel = 30 km
Current distinct road    = 27 km
Historical union overlap = 12 km
Unique KM                = 27 - 12
                         = 15 km
```

**Expected Driver 301 UKM = 15 km.**

Important: if the 3 km self-repeat happens to lie inside the 12 km historical section, the system must still use geometry/set operations. It must not subtract the same physical road twice.

---

# 5. Why Driver-by-Driver Subtraction Is Wrong

The following approach must never be used:

```text
Current route overlap with Driver 101 = 12 km
Current route overlap with Driver 201 =  4 km
Current route overlap with Driver 205 =  3 km
Duplicate = 12 + 4 + 3
```

Those historical drivers may overlap each other.

Instead:

```text
H = UNION(
  Driver 101 historical coverage,
  Driver 102 historical coverage,
  Driver 201 historical coverage,
  Driver 205 historical coverage,
  Driver 301's own historical coverage,
  every other eligible historical trip
)

Unique = CurrentDistinct - H
```

You may still report “current overlap with Driver 101 = 12 km” for analysis, but individual driver-overlap values are **not additive**.

---

# 6. Coverage Scope — Do Not Deduplicate Unrelated Programmes

The user requirement says projects must compare against each other. That does not necessarily mean every customer/project ever loaded into the database should share one permanent history.

Introduce a **Coverage Scope** (or Programme/Campaign/Cycle).

Example:

```text
Coverage Scope: HOUSE-CAPTURE-2026
  Project A
  Project B
  Project C
  Project D
```

All of those projects share historical road coverage.

A completely unrelated programme can have another scope:

```text
Coverage Scope: CUSTOMER-B-REFRESH-2027
```

Recommended fields:

```text
Project.coverageScopeId
Trip.coverageScopeId
```

Stamp `Trip.coverageScopeId` when the trip starts, exactly like `projectId` is stamped today. Historical trips must not change meaning when a driver/project is later reassigned.

Also consider a `coverageCycleId` if the business will intentionally reset uniqueness for a new annual/customer capture cycle. The user's present rule says previous months/years should count as history, so use the same cycle until the business deliberately starts a new one.

---

# 7. Current Repository — What Is Already Implemented

This section describes the **original uploaded repository**, not the desired final state.

## 7.1 `backend/src/models/Trip.js`

Already good/useful:

- stores `driverId`;
- stores `projectId` on the trip itself;
- stores `startedAt` and `endedAt`;
- stores raw `distanceMeters`;
- stores `cleanedDistanceMeters`;
- stores `cleanedRouteShapes`;
- stores map-match status and timestamps;
- stores `cleanedMatchedRatio`;
- stores current trip-level UKM fields:
  - `ukmMeters`
  - `ukmWithinTripMeters`
  - `ukmNewShapes`
  - `ukmComputedAt`

This is a good foundation because UKM can be derived and persisted at the trip level.

What is currently wrong for the new requirement:

- comments and semantics define `ukmMeters` as road not covered by an earlier trip **by the same driver**;
- there is no `coverageScopeId`;
- there is no separate historical duplicate metric;
- there is no explicit unmatched/review UKM metric;
- there is no exact per-road-section first-observed timestamp mapping.

## 7.2 `backend/src/services/mapMatcher.js`

Already good/useful:

- processes completed/timed-out trips asynchronously;
- retrieves raw points in `recordedAt` order;
- calls Valhalla;
- stores cleaned distance and shapes;
- stores `cleanedMatchedRatio`;
- does not block the live ingest path;
- has worker claiming so two workers do not process the same map-match job simultaneously;
- detects stale UKM if geometry is re-matched.

Current gap:

```js
await recomputeDriverUkm(trip.driverId)
```

This recomputes only one driver's history. A late/offline trip from Driver 101 can change the rightful global ownership of a road currently credited to Driver 201, but Driver 201 is not recomputed.

The worker must eventually recompute/reconcile the **coverage scope**, not only the driver.

## 7.3 `backend/src/services/roadSegments.js`

This is the strongest current UKM implementation in the repository.

Already good/useful:

- works from snapped/map-matched geometry instead of noisy raw GPS;
- removes repeats within the same trip;
- uses direction-independent segment keys (`A->B` equals `B->A`);
- produces `ukmNewShapes` in the same calculation that produces `ukmMeters`;
- recomputes history oldest-first;
- is deterministic for a single driver's late/offline trips.

Current core defect:

```js
Trip.find({ driverId, ... })
```

The `seen` set is created independently for each driver.

Therefore:

```text
Driver 101 covers Road X -> Road X is new for Driver 101
Driver 201 covers Road X -> Road X can still be new for Driver 201
```

That violates the required global first-cover rule.

Second limitation:

The road identity is based on exact/rounded endpoint pairs from the snapped polyline. This assumes repeated map matches produce equivalent vertices. That is not guaranteed for every partial traversal, chunk boundary or network/matcher behaviour.

Example:

```text
First traversal vertices:  A -------- B -------- C
Second traversal:                D ----------- E
```

Even if `D-E` lies on the same physical road as `A-B-C`, endpoint-pair keys can differ. The system can falsely call part of the second traversal unique.

For contractual/global UKM, canonical road IDs + along-road measures are stronger than arbitrary polyline vertex pairs.

## 7.4 `backend/src/services/ukmCompute.js`

This is the older UKM implementation.

It:

- reads raw `LocationPoint` rows;
- rounds coordinates to approximately 11 m cells;
- creates edge keys between consecutive cells;
- removes repeated edges inside one trip;
- writes them to `UkmEdge`.

Current defect for the requested requirement:

The method uses raw GPS grid cells. GPS error can be larger than the grid, so the same street can create different cell edges on different drives.

This code should **not be the authoritative source for production/global UKM**.

## 7.5 `backend/src/models/UkmEdge.js`

Current unique index:

```js
{ edgeKey: 1, driverId: 1 }
```

This explicitly means:

> one road can be unique once for every driver.

That is opposite to the required business rule.

It is useful as an old/self-repeat diagnostic, but should be deprecated as the authoritative UKM source once the global engine is live.

## 7.6 `backend/src/controllers/tracking.controller.js` — `/ukm`

The current endpoint has two different concepts:

- per-driver unique KM comes from the per-driver `UkmEdge` rows;
- fleet unique KM additionally groups by `edgeKey` across drivers.

This means the fleet total partially understands cross-driver duplication, but the driver credit does not.

### Important current date-range problem

`rawKm` is created from trips selected by the requested `from/to` range.

But the `UkmEdge` aggregation for each selected driver matches the `driverId` and does **not** restrict the edges to the selected trip IDs/date range.

Therefore a report for a small date window can combine:

```text
Raw KM = selected date range
Unique KM = driver's stored historical/lifetime UkmEdge total
```

The same issue applies to fleet edge aggregation over selected drivers.

This must be removed in the final implementation. Date-range reports should sum **trip-level globally attributed UKM** for trips/events in the selected range, while the historical comparison used to decide uniqueness still includes all earlier eligible history.

## 7.7 `/ukm-driver/:driverId`

The endpoint date-filters the displayed trips, but obtains the driver's `UkmEdge` unique total across the driver's edge collection rather than limiting it to the displayed historical attribution.

That can make displayed route/date figures disagree with the unique total.

## 7.8 `admin-panel/src/pages/Ukm.tsx`

The map currently derives a “unique” polyline again in the browser using its own ~11 m cell/edge set.

This is unsafe because:

- backend figures and frontend geometry are produced by different algorithms;
- the frontend only sees the displayed driver's routes;
- it does not have the full global historical union;
- it can show a green road that should be red/duplicate globally.

Final rule:

> **The backend makes the uniqueness decision once. The UI only renders backend-provided unique/duplicate/unmatched geometry.**

Never re-calculate UKM in React.

## 7.9 `backend/src/models/RoadLink.js`

This is very useful existing infrastructure.

It already represents a customer road network with:

- stable `linkId`;
- geometry;
- length in metres;
- direction of travel;
- project and network version;
- work area;
- functional class;
- spatial index.

This is closer to the correct canonical road identity required by the final UKM engine than raw GPS or arbitrary snapped vertices.

## 7.10 `backend/src/models/LinkCoverage.js`

This model already captures a very important business concept:

> a road link is claimed once by whoever got there first; another driver's pass does not create another project credit.

Existing fields include:

- `firstTripId`
- `firstDriverId`
- `firstAt`
- `firstFraction`
- repeat `passes`
- `lastTripId`
- `lastAt`

This is an excellent conceptual starting point.

However, it is **not yet the complete answer** because:

1. It is uniquely keyed by `(networkVersionId, linkId)`, not by a cross-project coverage scope.
2. Two projects can potentially hold separate network versions/copies of the same physical road.
3. One document per entire road link cannot precisely allocate partial overlap. If Driver 101 covers metres 0-600 of a 1,000 m link and Driver 201 later covers metres 400-1,000, Driver 201 should receive 400 m, not zero and not the whole 1,000 m.
4. During this review, the repository contains read/reporting use of `LinkCoverage`, but no active trip-attribution writer was found that converts completed map-matched trips into this ledger. Treat it as implemented schema/read-side foundation, not completed coverage attribution.

## 7.11 `backend/src/seed/backfillUkm.js`

Already good/useful:

- supports historical recomputation;
- is idempotent for the current per-driver implementation;
- works from stored cleaned shapes without re-calling Valhalla.

Required change:

- backfill must operate by `coverageScopeId`, chronologically across **all drivers**;
- it must rebuild global ownership, not call `recomputeDriverUkm(driverId)`.

---

# 8. Recommended Final Architecture

```text
Android / Driver App
        |
        v
Raw GPS + recordedAt + driverId + projectId
        |
        v
Trip / LocationPoint storage
        |
        v
GPS Quality Validation
        |
        v
Valhalla Map Matching
        |
        +------> unmatched / synthetic -> REVIEW, not automatic UKM
        |
        v
Canonical Road Attribution
RoadLink + along-road start/end measures
        |
        v
Current Trip Traversal Intervals
        |
        v
UNION intervals inside current trip
(remove loops/re-drives)
        |
        v
Global Historical Coverage Ledger
same Coverage Scope / Cycle
all drivers + all projects + own history
        |
        v
Interval Difference
        |
   +----+----+
   |         |
   v         v
UNIQUE    DUPLICATE
   |         |
   +----+----+
        |
        v
Persist trip metrics + server-generated shapes
        |
        v
API / Reports / CSV / KML / Map
```

---

# 9. Canonical Road Attribution — Required for Final Accuracy

## 9.1 Do not compare raw coordinates directly

Two cars on the same road can be several metres apart in GPS coordinates.

Raw geometry intersection can therefore say “different” even when both cars drove the same physical road.

## 9.2 Do not make arbitrary snapped vertices the long-term canonical ID

Valhalla snapping is a major improvement, but the final identity should be a road link plus position along that link.

Recommended logical representation:

```text
canonicalRoadId
startMeasureMeters
endMeasureMeters
```

Example:

```text
Road R001 length = 1000 m
Driver 101 = R001 [0, 600]
Driver 201 = R001 [400, 1000]
```

Historical after Driver 101:

```text
R001 [0, 600]
```

Driver 201 overlap:

```text
R001 [400, 600] = 200 m duplicate
```

Driver 201 new portion:

```text
R001 [600, 1000] = 400 m unique
```

This is the correct result.

## 9.3 Recommended implementation choice for this repository

Because the repository already has `RoadLink`, use the customer/canonical road network whenever it exists.

Create a traversal model such as:

```js
TripRoadTraversal {
  coverageScopeId,
  tripId,
  driverId,
  projectId,
  roadLinkId,          // canonical identity
  startMeasureMeters,
  endMeasureMeters,
  firstObservedAt,
  lastObservedAt,
  direction,
  matchConfidence,
  geometrySource,      // matched / fallback / synthetic
  eligibleForUkm
}
```

Before historical comparison, merge overlapping intervals belonging to the same current trip and road link.

---

# 10. Global Historical Coverage Representation

There are two acceptable engineering strategies.

## Option A — Disjoint Along-Road Intervals (preferred for exactness)

Store or derive disjoint coverage intervals per canonical road.

Example ledger:

```text
R001 [0,600]     -> first Driver 101
R001 [600,1000]  -> first Driver 201
```

Advantages:

- exact partial-road accounting;
- storage efficient;
- deterministic ownership;
- supports audit/dispute analysis.

Disadvantage:

- interval splitting/merging is more complex than a simple set.

## Option B — Small Coverage Atoms

Split every canonical road into fixed pieces, for example 5 m or 10 m.

```text
R001:00000
R001:00001
R001:00002
...
```

Global key:

```text
coverageScopeId + canonicalRoadId + atomIndex
```

First eligible traversal owns the atom.

Advantages:

- easier implementation;
- easy concurrency/unique index;
- easy map colouring and aggregation.

Disadvantages:

- approximate at atom boundaries;
- more database rows;
- do not count a full atom merely because one tiny endpoint touches it; define a coverage threshold or store covered fraction.

For billing-grade exactness, Option A is stronger. For a faster implementation with a documented tolerance, 5-10 m atoms are practical.

---

# 11. Correct Processing Order

The winning driver is the driver who **actually reached a road portion first**, not the driver whose upload reached the server first.

Wrong ownership basis:

```text
createdAt in MongoDB
upload arrival time
map-match completion time
```

Correct basis:

```text
recordedAt / validated observation time for the road portion
```

Example:

```text
Driver 101 drives Road X at 09:00, phone offline, uploads 18:00
Driver 201 drives Road X at 11:00, uploads 11:10
```

Driver 101 must own the first coverage.

The current code already stores raw points ordered by `recordedAt`, which is helpful. The final traversal attribution must preserve road-section time correspondence.

---

# 12. Why Trip `startedAt` Alone Is Not Sufficient

Example:

```text
Driver A trip starts 08:00
Driver A reaches Road X at 11:00

Driver B trip starts 09:00
Driver B reaches Road X at 09:30
```

Sorting trips by `startedAt` would give Road X to Driver A. That is wrong.

For exact cross-driver same-day attribution, calculate/retain `firstObservedAt` per canonical road interval/atom.

If the first implementation cannot yet preserve segment-level time, trip-start ordering may be used only as a documented temporary approximation — **not as the final contractual answer**.

---

# 13. Required Data Model Changes

Names may be adjusted to team conventions, but the information must exist.

## 13.1 Project

Add:

```js
coverageScopeId
```

Optional:

```js
coverageCycleId
```

## 13.2 Trip

Add/stamp:

```js
coverageScopeId
coverageCycleId // optional
```

Recommended UKM fields:

```js
ukmStatus: 'pending' | 'computed' | 'review' | 'failed'

rawTravelMeters
cleanedTravelMeters
currentDistinctMeters
historicalDuplicateMeters
globalUniqueMeters
unmatchedReviewMeters
sameTripRepeatMeters

ukmUniqueShapes
ukmDuplicateShapes
ukmUnmatchedShapes

ukmComputedAt
ukmAlgorithmVersion
```

Keep existing raw/cleaned fields; do not destroy historical evidence.

## 13.3 TripRoadTraversal

Recommended new derived model:

```js
coverageScopeId
tripId
driverId
projectId
roadLinkId
startMeasureMeters
endMeasureMeters
firstObservedAt
lastObservedAt
direction
matchConfidence
geometrySource
eligibleForUkm
```

Index at minimum:

```text
coverageScopeId + roadLinkId
tripId
firstObservedAt
```

## 13.4 Coverage Ledger

If using interval approach:

```js
CoverageInterval {
  coverageScopeId,
  roadLinkId,
  startMeasureMeters,
  endMeasureMeters,
  firstTripId,
  firstDriverId,
  firstProjectId,
  firstAt,
  passCount,
  lastTripId,
  lastDriverId,
  lastAt
}
```

Intervals for one road must remain disjoint.

If using atoms, use a unique key:

```text
coverageScopeId + roadLinkId + atomIndex
```

---

# 14. Required UKM Algorithm

Pseudocode:

```text
function computeCoverageScope(scopeId):

    traversals = all eligible TripRoadTraversal rows in scopeId
                 sorted by firstObservedAt, then deterministic tie-breaker

    historicalByRoad = empty interval-union structure

    for each traversal event / trip in chronological order:

        currentByRoad = UNION intervals inside current trip

        distinctMeters = length(currentByRoad)
        uniqueMeters = 0
        duplicateMeters = 0

        for each roadId in currentByRoad:
            currentIntervals = currentByRoad[roadId]
            historyIntervals = historicalByRoad[roadId]

            uniqueIntervals = DIFFERENCE(currentIntervals, historyIntervals)
            duplicateIntervals = INTERSECTION(currentIntervals, historyIntervals)

            uniqueMeters += length(uniqueIntervals)
            duplicateMeters += length(duplicateIntervals)

            historicalByRoad[roadId] = UNION(historyIntervals, currentIntervals)

        persist trip metrics and geometry
```

Do not use:

```text
currentOverlapWithDriverA
+ currentOverlapWithDriverB
+ currentOverlapWithDriverC
```

for the final duplicate figure.

---

# 15. Edge Cases — Required Behaviour

Every item below should have an automated or controlled validation case.

## EC-01 — Different drivers, exact same road

```text
D101 covers 5 km first
D201 covers same 5 km later
```

Expected:

```text
D101 UKM = 5 km
D201 UKM = 0 km
```

## EC-02 — Different projects, same coverage scope

```text
Project A / D101 first
Project B / D201 later
same road
```

Expected:

```text
D201 = duplicate
```

Project boundary must not reset uniqueness.

## EC-03 — Same driver repeats on later day/month/year

Expected:

```text
first pass = unique
later pass = duplicate
```

## EC-04 — Same trip repeats itself

Example:

```text
A -> B -> A -> C
```

Expected:

- physical distance includes both A traversals;
- distinct current coverage contains A once;
- UKM is calculated from distinct current coverage.

## EC-05 — Historical drivers overlap each other

```text
D101 historical = 12 km
D201 historical = 4 km fully inside D101's 12 km
```

Expected historical union = **12 km**, not 16 km.

## EC-06 — Partial historical overlap

```text
D101 = Road R001 metres 0-600
D201 later = metres 400-1000
```

Expected D201:

```text
duplicate = 200 m
unique    = 400 m
```

## EC-07 — Zero UKM trip

If every distinct road in the current trip already exists in history:

```text
globalUniqueMeters = 0
```

This is a valid result, not an error.

## EC-08 — Opposite travel direction

Current `roadSegments.js` treats direction as irrelevant.

Default recommended business rule for **road coverage**:

```text
A -> B and B -> A = same coverage
```

But because the use case is photographing houses, confirm camera semantics.

If opposite directions capture different required sides of the street, introduce:

```text
roadLinkId + direction/captureSide
```

as part of the coverage requirement. Do not change this silently later; it changes UKM materially.

## EC-09 — Dual carriageway / parallel roads

Two physically separate carriageways must not be merged merely because they are close together.

Use canonical road-link identity, direction and topology. A simple distance buffer/grid is insufficient.

## EC-10 — Flyover / bridge crossing another road

Roads that geometrically cross in 2D but are grade-separated are different roads.

Do not use coordinate intersection alone as road identity.

## EC-11 — GPS drift

Same road, GPS traces 5-20 m apart.

Expected:

map matching/canonical road attribution recognises the same road.

Do not use raw ~11 m grid edges as authority.

## EC-12 — GPS stationary jitter

Parked vehicle produces moving coordinates around one point.

Expected:

no meaningful UKM.

## EC-13 — Impossible GPS jump

A point jumps hundreds of metres/kilometres in seconds.

Expected:

reject/quarantine the bad segment before UKM.

## EC-14 — Missing GPS interval

If the vehicle has a long observation gap, do not automatically assume the entire shortest path was validly covered for billing.

Current Valhalla gap-fill behaviour must be tagged so synthetic/fallback sections can be excluded or reviewed.

## EC-15 — Partially map-matched trip

`cleanedMatchedRatio < 1` currently indicates some part was not genuinely snapped.

Expected final behaviour:

- confidently matched portion can be evaluated;
- unmatched/fallback portion becomes `unmatchedReviewMeters` unless a defined policy approves it;
- do not treat aggregate `mapMatchStatus='matched'` as proof every metre is matched.

## EC-16 — Completely failed/skipped map match

Expected:

```text
UKM status = pending/review/failed
UKM value  = NULL, not 0
```

`0` means “validly processed and none was unique.” `NULL` means “not established.”

## EC-17 — Offline trip uploaded late

Use observation time, not upload time.

A late earlier trip can require reattributing first-cover ownership from a later trip.

## EC-18 — Two drivers covering the same road concurrently

Use per-road-section `firstObservedAt`.

If timestamps are exactly equal within system resolution, define a deterministic tie-breaker, for example:

```text
firstObservedAt
then tripId
then driverId
```

Never let whichever Mongo insert wins randomly determine contractual ownership.

## EC-19 — Device clock is wrong

Because event time determines first ownership, timestamp quality matters.

Validate:

- future timestamps;
- impossible old timestamps;
- non-monotonic timestamps;
- large device/server clock offset.

Prefer GNSS/provider observation time when available; retain server `receivedAt` separately.

## EC-20 — Trip starts first but reaches road later

Do not assign road ownership solely from `trip.startedAt`.

Use segment/interval observation time.

## EC-21 — Re-map matching changes geometry

If Valhalla reprocessing changes a trip's cleaned route:

- remove/rebuild its derived traversal intervals;
- recompute affected global ownership from the earliest changed time;
- later drivers may gain or lose UKM.

Current per-driver stale detection is a useful pattern, but final invalidation must operate at coverage-scope level.

## EC-22 — Historical trip deleted/invalidated

Never hard-delete coverage ownership without reconciliation.

If the first-cover trip is invalidated, the **next earliest eligible traversal** of that road section should receive the credit.

Recommended:

```text
Trip.coverageEligible = false
reason = ...
```

then rebuild affected coverage history.

Maintain audit records.

## EC-23 — Driver/project reassignment after trip

Existing code correctly stamps project history on the trip.

Do the same with coverage scope/cycle. Later personnel reassignment must not rewrite old coverage ownership.

## EC-24 — Driver has multiple projects at trip start

Current code leaves `projectId=null` when assignment is ambiguous. Do not silently guess.

For final UKM, either:

- require an explicit active project/area on device; or
- spatially resolve the target road/project; or
- send the trip/road portion to an unattributed review queue.

Global road uniqueness may still be known, but commercial project credit must be explicit.

## EC-25 — Driver goes outside assigned project polygon

Separate two questions:

1. Was this road globally new?
2. Was this road valid work for this driver's/project's assignment?

Recommended report fields:

```text
globalUniqueKm
inAssignedScopeUniqueKm
outOfAssignmentKm
```

A driver accidentally capturing a new road in Project B while assigned to Project A may create valid global first coverage, but it should not automatically become billable Project A output.

## EC-26 — Project polygons overlap

Do not double-count the road because two polygons contain it.

The road segment has one global coverage state. Project allocation must follow an explicit ownership rule.

## EC-27 — Road network version changes

Never let a new network version erase historical meaning.

Use stable canonical link IDs where possible. If geometry changes significantly, create a controlled network/cycle migration.

`NetworkVersion` already provides useful versioning infrastructure.

## EC-28 — New road missing from canonical network

Expected:

```text
UNMATCHED / NEW-ROAD REVIEW
```

Do not automatically count as unique merely because no old road ID exists.

A reviewer can add/map the road and re-run attribution.

## EC-29 — Private driveway / parking lot / non-target road

Map-matched does not necessarily mean contractually eligible.

UKM should use only target road classes/access rules required by the project.

## EC-30 — Very short start/end fragments

Avoid awarding accidental centimetres/metres created by map-match stitching.

Define minimum traversal/coverage thresholds and boundary tolerance, but preserve the raw evidence.

## EC-31 — Roundabouts, U-turns and loops

Canonical road intervals + within-trip union should naturally remove repeat credit while retaining physical KM.

## EC-32 — Duplicate mobile upload

Existing `clientTripId + driverId` idempotency is good and must remain.

The same trip re-upload must not create another first-coverage event.

## EC-33 — Trip resume creates multiple server trips

Even if operational logic splits one field journey into multiple trips, global coverage union prevents repeated road from receiving new UKM again.

## EC-34 — Date-range report

Example report date = 28 Aug.

Historical comparison must include all eligible coverage before each 28 Aug traversal, even if it occurred years earlier.

But the report total must include only UKM actually attributed to events/trips in the selected reporting window.

Never use “history only inside the selected date range” to decide uniqueness.

## EC-35 — Time zone boundary

Uniqueness is based on absolute event chronology.

Daily reporting can use the trip's stamped local timezone (the repository already stores trip timezone), but changing a date filter must not change which driver owns a road.

## EC-36 — Same road covered by 1, 10 or 100 previous drivers

For current UKM the answer is identical:

```text
already covered = yes
current UKM for that portion = 0
```

Pass count may be stored for productivity analysis, but it cannot increase historical covered length.

## EC-37 — Historical overlap attribution analytics

If business wants to know “which drivers did the current driver overlap?”, compute that separately.

Do not add those overlaps to produce duplicate KM because overlap sources can overlap each other.

## EC-38 — House imagery missing/camera failure

If business ultimately pays for successfully captured houses, a globally unique road pass with failed camera/images should not automatically become accepted delivery.

Keep:

```text
uniqueDrivenKm
acceptedCaptureUkm
```

as separate values.

---

# 16. Backend Must Be the Single Source of Truth

The final backend should persist and return:

```text
rawKm
cleanedKm
distinctKm
sameTripRepeatKm
historicalDuplicateKm
uniqueKm
unmatchedKm
ukmStatus
```

and map layers:

```text
full cleaned route
unique shapes
duplicate shapes
unmatched/review shapes
```

The admin frontend must only render them.

Remove client-side UKM recomputation from `Ukm.tsx`.

---

# 17. Recommended API Output

Example driver/day row:

```json
{
  "driverId": "D301",
  "projectId": "PROJECT-C",
  "coverageScopeId": "HOUSE-CAPTURE-2026",
  "date": "2026-08-28",
  "rawKm": 30.0,
  "cleanedKm": 29.4,
  "distinctKm": 27.0,
  "sameTripRepeatKm": 3.0,
  "historicalDuplicateKm": 12.0,
  "uniqueKm": 15.0,
  "unmatchedKm": 0.0,
  "ukmStatus": "computed"
}
```

Do not force the equation `raw = duplicate + unique`. Raw contains self-repeat/noise/unmatched effects.

The more useful identity is approximately:

```text
distinct eligible matched km = historical duplicate km + global unique km
```

subject to explicitly separated review/excluded portions.

---

# 18. Map Behaviour

Recommended colours:

```text
Green  = globally unique current-trip coverage
Red    = historical duplicate current-trip coverage
Yellow = same-trip repeat, if visualised separately
Orange = unmatched / review
Grey   = historical coverage / full route context
Blue   = assigned target/not-yet-covered road network
```

Clicking a road interval should provide audit information:

```text
Road / link ID
start-end measure
current trip
current driver
current project
current observed time
status: unique / duplicate / review
first-cover trip
first-cover driver
first-cover project
first-cover time
pass count
match confidence
```

---

# 19. Reporting Requirements

Per driver/day/project, provide:

| Field | Meaning |
|---|---|
| Raw KM | Physical GPS accumulated distance |
| Cleaned KM | Map-matched route distance |
| Distinct KM | Current-trip road union |
| Same-trip Repeat KM | Physical re-drive within current trip |
| Historical Duplicate KM | Distinct current road previously covered |
| Global UKM | New road first covered by this driver |
| Unmatched/Review KM | Cannot confidently classify |
| UKM Status | Computed / pending / review / failed |
| Project | Historical stamped project |
| Coverage Scope | Dedup universe |

Recommended totals:

- per driver;
- per day;
- per project;
- per coverage scope;
- per manager;
- per work area;
- per country;
- cumulative programme coverage.

CSV/KML/export must use the same persisted backend values as the dashboard.

---

# 20. Implementation Plan Against This Repository

## Phase 0 — Freeze the business rules

Before code changes, write configuration for:

1. Is opposite direction the same road coverage? Recommended default: **yes**.
2. Does a new annual/customer campaign reset uniqueness? If yes, new `coverageCycleId`.
3. Must valid image/camera evidence be present for billable UKM?
4. Does out-of-assignment global unique road count to the driver's productivity only, or also to project delivery?
5. Minimum map-match confidence / unmatched policy.

Do not bury these as magic constants.

## Phase 1 — Add Coverage Scope

Files:

```text
backend/src/models/Project.js
backend/src/models/Trip.js
project creation/update APIs
trip creation/ingest
admin Projects UI
```

Requirements:

- every project belongs to a coverage scope;
- every new trip stamps it at trip start;
- legacy trips get an explicit migration result;
- do not silently assign ambiguous legacy trips.

## Phase 2 — Stop Using `UkmEdge` as Authoritative UKM

Files:

```text
backend/src/services/ukmCompute.js
backend/src/models/UkmEdge.js
backend/src/controllers/tracking.controller.js
```

Actions:

- keep old collection temporarily for comparison/debug only;
- stop new production reports from reading it as authoritative;
- remove the auto-backfill side effect from a GET request;
- do migrations/backfills through explicit jobs/scripts.

A read-only dashboard endpoint should not unexpectedly perform a fleet data migration.

## Phase 3 — Build Canonical Trip Traversals

Use `cleanedRouteShapes` plus the active canonical `RoadLink` network to derive road-link intervals.

For each matched trip:

1. select candidate RoadLinks in the route bbox;
2. match the cleaned route to the correct road link using geometry + topology/direction;
3. produce along-link start/end measures;
4. preserve segment observation time;
5. mark source as genuinely matched vs fallback/synthetic;
6. store `TripRoadTraversal` rows.

Do not award UKM to unmatched/fallback pieces without policy approval.

## Phase 4 — Implement Current-Trip Union

Within each trip and canonical road:

```text
merge overlapping/touching traversal intervals
```

This produces distinct current coverage and eliminates loops/repeated passes.

## Phase 5 — Implement Global Historical Union

Process by:

```text
coverageScopeId
coverageCycleId
firstObservedAt
```

Historical set contains **all drivers and all projects in the same scope/cycle**.

For every current interval:

```text
unique = difference(current, history)
duplicate = intersection(current, history)
```

Then add current coverage to history.

## Phase 6 — Persist Result on Trip

Write trip-level values and server-generated geometry.

Do not make dashboards recompute historical geometry.

## Phase 7 — Concurrency Protection

Two servers/trips must not race to claim the same road.

Acceptable options:

- distributed lock/lease per `coverageScopeId` while building/reconciling the ledger;
- transactional/atomic interval/atom claims with deterministic earliest-time resolution.

For the first reliable implementation, serialising attribution per scope is simpler and safer.

## Phase 8 — Late-Trip / Re-match Reconciliation

If a trip is inserted/re-matched with an event time older than already processed coverage:

```text
find earliest affected event time
rebuild coverage ownership from that point forward within the scope
```

For small/medium datasets, rebuilding the entire scope is acceptable initially because correctness is more important than premature optimisation.

## Phase 9 — Replace UKM APIs

Update:

```text
GET /api/tracking/ukm
GET /api/tracking/ukm-driver/:driverId
GET /api/tracking/ukm-export
```

They should aggregate persisted trip/global attribution results, not `UkmEdge`.

Date filters affect **which credited trips/events are reported**, not the historical universe used when the credit was calculated.

## Phase 10 — Frontend

Update:

```text
admin-panel/src/pages/Ukm.tsx
admin-panel/src/pages/TripDetail.tsx
admin-panel/src/pages/Reports.tsx
admin-panel/src/lib/types.ts
```

Remove client-side uniqueness calculation.

Render backend geometry/status only.

## Phase 11 — Exports

Update CSV/KML/JSON/export runner so every surface uses the same fields.

Recommended CSV columns:

```text
Date
Driver ID
Driver Name
Project ID
Project Name
Coverage Scope
Trip ID
Raw KM
Cleaned KM
Distinct KM
Same-trip Repeat KM
Historical Duplicate KM
Unique KM
Unmatched/Review KM
UKM Status
Map Match Ratio
UKM Algorithm Version
```

## Phase 12 — Migration / Backfill

1. Back up database.
2. Assign projects to coverage scopes.
3. Stamp/migrate legacy trips where attribution is unambiguous.
4. Ensure historical completed trips are map matched.
5. Generate canonical traversal intervals.
6. Rebuild global coverage oldest-event-first.
7. Persist trip metrics.
8. Compare new totals with old UkmEdge/per-driver figures.
9. Investigate material differences; do not force new totals to agree with a known-wrong legacy algorithm.
10. Cut dashboard/report APIs over only after validation.

---

# 21. Automated Acceptance Tests — Minimum Required

Do not release global UKM without tests covering at least these cases.

## Test A — Same driver repeat

```text
Trip 1: R1 = 5 km
Trip 2: same R1 = 5 km
Expected: T1 UKM=5, T2 UKM=0
```

## Test B — Cross-driver exact repeat

```text
D101 R1 5 km first
D201 R1 5 km later
Expected: D101=5, D201=0
```

## Test C — Cross-project exact repeat

Projects different, scope same.

Expected second driver/project = 0.

## Test D — Historical nested overlap — mandatory business example

```text
D101 historical overlap = 12 km
D201 historical overlap = 4 km fully inside D101's 12
Current physical = 30 km
Current same-trip repeat = 3 km
Current distinct = 27 km
```

Expected:

```text
historical union = 12 km
current UKM = 15 km
```

## Test E — Historical partial overlap

```text
D101 history R1 [0,600]
D201 current R1 [400,1000]
Expected D201 duplicate=200m, unique=400m
```

## Test F — Current self-repeat overlaps historical

Ensure geometry is not subtracted twice.

## Test G — Zero UKM

All current distinct coverage exists historically.

Expected `unique=0`, status `computed`.

## Test H — Offline earlier trip arrives later

Insert later trip first, then older observed trip.

After reconciliation, earlier observed traversal owns the road.

## Test I — Trip starts earlier but reaches road later

Ownership follows road observation time, not trip start.

## Test J — Same road opposite direction

Verify configured direction policy.

## Test K — Parallel roads

Two nearby but separate canonical links must remain separate.

## Test L — Partial/unmatched map match

Unmatched portion must not silently become unique.

## Test M — Invalidated first-cover trip

Invalidate first trip and rebuild.

Next earliest valid traversal should gain ownership.

## Test N — Date-range reporting

A report for Day 2 must use Day 1/year-old history to decide Day 2 UKM, but only Day 2 credited UKM appears in the Day 2 report.

## Test O — Re-match changes road geometry

Reconciliation must update later ownership/UKM deterministically.

## Test P — Concurrency

Process two overlapping trips simultaneously in two workers.

Final ownership must be deterministic and equal to a single-thread historical replay.

---

# 22. Reconciliation Invariants

Add automated database/audit checks.

For every computed trip:

```text
uniqueMeters >= 0
duplicateMeters >= 0
distinctMeters >= 0
```

Within tolerance:

```text
distinctEligibleMeters ~= uniqueMeters + duplicateMeters
```

For a scope:

```text
sum(first-covered disjoint road intervals)
=
length(global historical coverage union)
```

No canonical road interval/atom may have two different first owners in the same scope/cycle.

A later driver can have a repeat/pass record, but not another first-cover credit for the same physical interval.

`UKM=0` and `UKM=NULL` must never be treated as the same status.

---

# 23. Performance / Scaling

Never compare today's raw GPS points against every historical GPS point.

The scalable shape is:

```text
current route
 -> canonical road IDs
 -> only historical coverage for those road IDs
 -> interval/atom difference
```

Indexes should include:

```text
Trip: coverageScopeId + startedAt
TripRoadTraversal: coverageScopeId + roadLinkId
TripRoadTraversal: tripId
Coverage ledger: coverageScopeId + roadLinkId
Coverage ledger: firstAt
```

If atom model is used:

```text
unique(coverageScopeId, roadLinkId, atomIndex)
```

If interval model is used, attribution should be serialised/transactional per affected road/scope.

Do not re-scan millions of raw `LocationPoint` documents for normal dashboard reads.

---

# 24. Auditability

For every UKM metre, the system should eventually be able to answer:

```text
Which canonical road is this?
Which driver first covered it?
Which trip?
Which project?
What exact time?
What was the original GPS evidence?
What was the map-matched geometry?
Was the match valid or synthetic/fallback?
How many later passes occurred?
Was imagery/camera evidence valid?
Which algorithm/network version produced the decision?
```

Recommended metadata:

```text
ukmAlgorithmVersion
networkVersionId
coverageScopeId
coverageCycleId
mapMatchedAt
ukmComputedAt
```

Never overwrite raw GPS evidence when recomputing UKM.

---

# 25. What Should Be Deprecated After Cutover

After the global implementation passes validation:

## `UkmEdge`

- stop using it for business UKM;
- optionally retain temporarily for old-dashboard comparison;
- remove once migration/audit sign-off is complete.

## Browser-side unique computation in `Ukm.tsx`

Remove completely.

## `recomputeDriverUkm(driverId)` as authoritative metric

Replace with scope/global attribution. It can remain only as a diagnostic if needed.

## Hidden GET-side backfill

Do not allow `/ukm` reads to trigger data migrations. Use explicit jobs with logs/status.

---

# 26. Suggested Final Naming

Avoid ambiguous “UKM” internally.

Prefer explicit names:

```text
rawTravelMeters
cleanedTravelMeters
distinctRoadMeters
sameTripRepeatMeters
historicalDuplicateMeters
globalUniqueMeters
unmatchedReviewMeters
acceptedCaptureUniqueMeters
```

The UI may call `globalUniqueMeters / 1000` simply **UKM** after everyone agrees on the definition.

---

# 27. Definition of Done

The feature is **not complete** just because a green line appears on the map.

Global UKM is done only when all of the following are true:

- [ ] All projects that should cross-deduplicate share an explicit coverage scope.
- [ ] Every new trip stamps its project and coverage scope at trip start.
- [ ] Historical trips have been migrated or explicitly quarantined when ambiguous.
- [ ] Raw GPS is preserved.
- [ ] Completed valid trips are map matched.
- [ ] Canonical road identity is used for UKM.
- [ ] Repeats inside the current trip are unioned once.
- [ ] Historical coverage is unioned across all drivers/projects in the scope.
- [ ] Same driver's historical coverage is included automatically.
- [ ] Partial road overlap is measured correctly.
- [ ] Driver-to-driver historical overlap is never simply added.
- [ ] Same-day ownership uses road-section observation time for final production accuracy.
- [ ] Late/offline uploads deterministically reassign ownership when necessary.
- [ ] Map-match fallback/unmatched geometry is explicitly handled.
- [ ] Re-matching invalidates/recomputes affected global attribution.
- [ ] Invalidated/deleted trips can transfer first ownership to the next valid traversal.
- [ ] Concurrency cannot create two first owners.
- [ ] `0 UKM` is supported as a valid output.
- [ ] `NULL/review UKM` is distinct from zero.
- [ ] Date-range reports use all prior history for uniqueness but report only credited events in-range.
- [ ] Backend is the single source of truth for numbers and map colours.
- [ ] CSV/KML/dashboard/trip detail all show the same UKM decision.
- [ ] Cross-driver, cross-project and partial-overlap regression tests pass.
- [ ] The mandatory 12 km + nested 4 km + 3 km repeat example returns exactly 15 km under the stated geometry.
- [ ] Performance tests are run against realistic historical volume.
- [ ] Migration/backfill is logged, repeatable and idempotent.
- [ ] Audit data can explain who first covered any disputed road portion and when.

---

# 28. Recommended Delivery Sequence for the Developer

Implement in this order:

```text
1. Freeze UKM business rules
2. Add CoverageScope/Cycle
3. Stamp scope on trips
4. Build canonical road traversal/interval extraction
5. Add segment-level observation time
6. Union current-trip intervals
7. Build global historical interval/atom ledger
8. Compute unique / duplicate / unmatched
9. Persist trip metrics + server map geometry
10. Build reconciliation for late/re-matched/invalidated trips
11. Replace /ukm APIs
12. Remove frontend UKM calculation
13. Update reports/CSV/KML
14. Historical backfill
15. Automated edge-case test suite
16. Parallel-run old vs new for QA
17. Cut over to Global UKM
18. Deprecate UkmEdge business usage
```

Do not start by changing only the `UkmEdge` unique index from `(edgeKey, driverId)` to `edgeKey`. That would still use noisy raw GPS, would not solve partial-road ownership, and could make server upload race determine the winner.

---

# 29. Final Target Behaviour in One Sentence

> **For every eligible metre of canonical road travelled by a driver, award that metre only to the earliest valid traversal in the same coverage scope/cycle, regardless of driver or project; merge all previous coverage before comparison; remove current-trip repetition; preserve duplicate/review evidence; and use exactly that backend decision everywhere in the system.**

That is the end goal.
