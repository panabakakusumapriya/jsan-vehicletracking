# Asset custody & history — design

**Status:** ✅ **implemented** (steps 1–5 of §13). Step 6 — dropping the mobile fields from
`User` — is the one-way door and is deliberately still open.
**Date:** designed and built 2026-07-30
**Question it answers:** *"In June, which driver had which vehicle and which mobile device?"*

**Where it lives**

| Piece | File |
|---|---|
| Ledger | `backend/src/models/Assignment.js` |
| Devices | `backend/src/models/MobileDevice.js` |
| Assign / return / exit | `backend/src/services/assetCustody.js` |
| Month maths + timezone | `backend/src/utils/timezone.js` |
| Report + CSV | `backend/src/controllers/report.controller.js` |
| Backfill | `backend/src/seed/backfillCustody.js` (`npm run backfill:custody`) |
| Tests | `backend/test/custody.test.js` (`npm run test:custody`) — 57 assertions |
| UI | `admin-panel/src/pages/AssetHistory.tsx`, `Mobiles.tsx` |

Deviation from the plan: the monthly view is its own page (`/asset-history`) rather than a
tab inside `Reports.tsx`, which had become a 3D trip-replay screen — merging them would have
put unrelated work at risk for no benefit.

---

## 1. Why this can't be answered today

Every assignment in the system is stored as a **pointer that gets overwritten**:

| Collection | Field | On reassignment |
|---|---|---|
| `User` | `vehicleId` | previous vehicle — **gone** |
| `Vehicle` | `assignedDriverId` | previous driver — **gone** |
| `User` | `workPhone`, `imei`, `phoneModel`, `androidVersion`, `phoneCase`, `phoneScreenguard` | previous phone — **gone** |

The moment a manager moves a driver onto a different truck, last month's truth is destroyed.
The gap is not a missing report page — **the data was never retained**.

A second, subtler problem: a phone is currently *six fields describing a driver*, not a thing
that exists on its own. Consequences today:

- a phone cannot sit **in stock**, unassigned to anybody;
- you cannot ask *"where is IMEI 3561… right now?"*;
- two drivers can silently be given the **same IMEI** — nothing detects it;
- when a driver exits (`User.exitDate`), the phone's record leaves with them.

One thing already works in our favour: `Trip` and `LocationPoint` both store `vehicleId` at
the time of recording, so **trips are already historically correct for vehicles**. That gives
us real evidence to backfill from (§7) and a cross-check for the ledger.

---

## 2. The core idea

> Stop storing *who has what*. Store *who had what, and when*.

One append-only collection of **intervals**. A row has a start, and an end that is "open"
while the asset is still held. Reassignment is never an update — it **closes** the open row
and **opens** a new one. History becomes physically incapable of being lost.

```
Vehicle TS09AB1234
├── Derrick    01 Mar 2026 ──── 10 Jun 2026   (closed)
└── Joel       10 Jun 2026 ──── open          (holding it now)

Mobile  Redmi 12 · 3561…
├── Derrick    01 Mar 2026 ──── 18 Jun 2026   (closed)
├── — in stock —
└── Khow       25 Jun 2026 ──── open
```

Everything else — the monthly report, the audit trail, "days held", the driver timeline, the
device's life story — falls out of that one shape.

---

## 3. Schema

### 3.1 `Assignment` (new — the ledger)

One collection for **all** asset kinds, deliberately. Rationale in §9.

```js
{
  assetKind:   'vehicle' | 'mobile',   // extensible: 'trailer', 'fuelCard', 'dashcam'…
  assetId:     ObjectId,               // → Vehicle | MobileDevice
  driverId:    ObjectId,               // → User (role 'user')

  startedAt:   Date,
  endedAt:     Date,                   // OPEN_SENTINEL while held — see §4

  // --- snapshots: make a historical row readable forever, standalone ---
  managerId:   ObjectId,               // who owned the driver AT THE TIME
  country:     String,                 // drivers move countries — capture it at the time
  assetLabel:  String,                 // 'TS09AB1234' / 'Redmi 12 · 3561…'
  driverName:  String,

  // --- audit ---
  assignedBy:  ObjectId,               // which admin/manager did it
  releasedBy:  ObjectId | null,
  note:        String | null,          // 'swapped after breakdown'
  backfilled:  Boolean,                // true = inferred by migration, not observed (§7)
}
```

**Why the snapshots.** A report for March 2026 must still read correctly after the truck is
sold, the plate is re-issued, the manager changes, or the driver is deleted. Storing only
`assetId` would make old rows resolve to today's names — or to nothing. This is the single
most important decision in the schema, and it is cheap: a few strings per row.

### 3.2 `MobileDevice` (new — promoted out of `User`)

```js
{
  imei:         String,   // unique, sparse
  serial:       String | null,
  label:        String | null,   // 'Ops phone 07'
  phoneModel:   String | null,   // 'Redmi 12'
  androidVersion: String | null,
  workPhone:    String | null,   // the SIM's number
  phoneCase:    String | null,
  phoneScreenguard: String | null,

  managerId:    ObjectId | null,
  country:      String | null,
  status:       'in_stock' | 'assigned' | 'repair' | 'lost' | 'retired',
  currentDriverId: ObjectId | null,   // CACHE, derived from the open Assignment
  active:       Boolean,
}
```

The six fields currently on `User` move here. `User.imei` etc. are dropped **after** the
migration verifies every one has landed on a device (§7).

### 3.3 Unchanged, kept as caches

`User.vehicleId` and `Vehicle.assignedDriverId` stay exactly as they are, so the live map,
trip ingest and every existing query keep working untouched. They are **derived state**: the
ledger is the truth, these are the fast lookup. A repair script can rebuild both from the
ledger at any time, which is also how we'd detect drift.

---

## 4. The "open" interval — a decision with teeth

The natural encoding is `endedAt: null`. It reads well, and a partial unique index does
enforce the invariants. **Both were measured** (see §11 for the probe output):

| Encoding | Invariants enforced? | June-overlap query |
|---|---|---|
| `endedAt: null` + partial unique index | ✅ yes, E11000 | `OR` stage — **2225 keys, 506 docs** examined for 446 results |
| `endedAt: 9999-12-31` sentinel + plain unique index | ✅ yes, E11000 | clean `IXSCAN` — **593 keys, 446 docs** for 446 results |

The `null` form forces `$or: [{endedAt: null}, {endedAt: {$gt: from}}]`, and MongoDB cannot
serve an `$or` from a single index — it examines ~13% more documents than it returns. The
sentinel form makes "still open" just another value, so the range predicate becomes a plain
`IXSCAN` that touches **exactly the documents it returns**. Both were verified to return
**identical result sets**.

**Decision: store `endedAt = OPEN_SENTINEL` (9999-12-31T00:00:00Z), never null.**

Two consequences, both good:

- No `partialFilterExpression` needed. Plain compound unique indexes do the job (§5).
- The API must not leak `9999`. A Mongoose `toJSON` transform maps the sentinel back to
  `endedAt: null` in exactly one place, so every consumer sees the natural shape.

The one cost: anybody writing an ad-hoc query in the Mongo shell must know about the
sentinel. That's what this document and a comment on the schema are for.

---

## 5. Invariants, enforced by the database

Not by application code that someone might forget to call:

```js
{ assetKind: 1, assetId:  1, endedAt: 1 }  unique   // an asset has ONE holder at a time
{ assetKind: 1, driverId: 1, endedAt: 1 }  unique   // a driver holds ONE of each kind
```

Because "open" is a fixed value, these plain unique indexes make a double-assignment a
**write error (E11000)**, not a silent data corruption discovered months later in a report.
Verified: handing an open truck to a second driver is rejected; after the first row is
closed, the same truck reassigns cleanly and both rows are retained.

Supporting indexes for reads:

```js
{ startedAt: 1, endedAt: 1 }            // the month-overlap scan
{ driverId: 1, startedAt: -1 }          // one driver's timeline
{ assetKind: 1, assetId: 1, startedAt: -1 }  // one asset's life story
```

### The invariant an index *cannot* enforce

Unique indexes only stop two rows being open at once. They do **not** stop a backdated
assignment from overlapping a closed one — e.g. logging "Joel had the truck 1–10 June" when
Derrick already has a closed row for 5–20 June. That must be a validated write:

```js
// reject if any existing interval for this asset overlaps [startedAt, endedAt)
{ assetKind, assetId, startedAt: { $lt: newEnd }, endedAt: { $gt: newStart } }
```

This is the same predicate as the report query, which is a good sign the model is coherent.

---

## 6. The queries

### Everything, in one predicate

```js
// held at any point during [from, to)
{ startedAt: { $lt: to }, endedAt: { $gt: from } }
```

- **A month** → `from = 1 Jun`, `to = 1 Jul` — catches stints that started mid-month,
  ended mid-month, or spanned the whole thing.
- **A moment** (right now, or the day of an incident) → pass the same instant for both.
- **Days held** → `overlapDays = min(endedAt, to) − max(startedAt, from)`, which is what
  turns a log into something you can bill or audit from.

### Month boundaries are timezone-dependent — say so explicitly

You just added `timezone` to `User` and `Trip`, and this is exactly where it bites: "June"
for a Singapore driver starts 7 hours before "June" for a French one. A report that silently
uses UTC will hand you day-counts that are off by one at every boundary.

**Proposal:** the report takes an explicit `tz` parameter (default: the requesting user's
timezone, falling back to UTC), converts the month to a UTC instant range once, and shows the
timezone in the header and the CSV. Not a footnote — it goes in the UI.

### What Reports shows

```
June 2026 · Australia/Sydney                          [CSV]

Driver                  Vehicle       Held        Days  Mobile               Days
Derrick Leatitagaloa    TS09AB1234    1–10 Jun      9   Redmi 12 · 3561…      30
                        MH12XY9988    10–30 Jun    20
Khow Kok Wei            SGP-4471      full month   30   Galaxy A15 · 3598…    18
                                                        — none —             12
Joel Howells            — none —              0        Redmi 12 · 3561…      30
```

Gaps ("— none —") matter as much as holdings: an unassigned driver or an idle phone is
usually the thing a manager actually wants to see.

---

## 7. Migration & backfill

History starts empty. To make the first report useful rather than blank, backfill today's
state — with **evidence rather than guesses** where possible.

1. **Create devices.** For each `User` with any mobile field set, upsert a `MobileDevice`.
   Key on `imei` where present; fall back to `workPhone`, then a generated label.
   *Expected collision:* two drivers sharing an IMEI. That is a real data error the current
   schema permits — the migration must **report** these, not silently pick one.
2. **Open a vehicle assignment** for each driver with a `vehicleId`. For `startedAt`, use the
   **earliest trip that driver made in that vehicle** — real evidence, already in your data.
   Where no trip exists, fall back to `user.updatedAt` and set `backfilled: true`.
3. **Open a mobile assignment** for each device now held. No trip evidence exists for phones,
   so these are `backfilled: true` with `startedAt = user.updatedAt`.
4. **Verify, then drop.** Only after a check confirms every mobile field has landed on a
   device do we remove those six fields from `User`.

The UI should render `backfilled` rows visibly differently ("since at least …"), because a
made-up start date presented as fact is worse than an honest unknown.

**Reversibility:** the migration only *adds* collections until step 4. Steps 1–3 can be
re-run and rolled back freely; step 4 is the one-way door and ships separately, after you've
looked at the data.

---

## 8. API surface

```
POST   /api/assignments            { assetKind, assetId, driverId, startedAt?, note? }
                                   atomic: closes the driver's open row of that kind,
                                   closes the asset's open row, opens the new one
POST   /api/assignments/:id/return { endedAt?, note? }
GET    /api/assignments            ?from&to&driverId&assetId&assetKind   (raw intervals)
GET    /api/reports/custody        ?month=2026-06&tz=Australia/Sydney    (pivoted + days)
GET    /api/reports/custody.csv    same, as a download
GET    /api/mobiles                CRUD for the device inventory
```

**Atomicity:** close-old + open-new must not half-apply, or an asset ends up held by nobody
or by two people. Your Atlas cluster is a replica set (`replicaSet=atlas-…` in the URI), so
`session.withTransaction()` is available and should wrap the swap.

**Scoping** reuses the existing `accessibleDriverFilter`, so a manager sees only their own
drivers' history and an admin sees everything — consistent with the rest of the API.

---

## 9. Alternatives considered, and why not

**A change/audit log only** (`"assigned X to Y at T"` events). Can reconstruct any state, but
every question requires replaying the whole stream in application code, and "days held in
June" becomes a fold rather than a query. The interval ledger *is* an audit log — it records
`assignedBy` / `releasedBy` — while also being directly queryable. No reason to have both.

**A separate collection per asset type** (`VehicleAssignment`, `MobileAssignment`). The
headline question — "which driver had which vehicle **and** which phone" — becomes a join of
two collections and a merge in code, for every report. And a third asset type (trailer, fuel
card, dashcam) means a new collection, new endpoints, new UI. With one collection it is a new
value of `assetKind` — a data change, not a migration.

**Embedding a history array on `User`.** Unbounded document growth, and it makes the
asset-centric question ("where has this phone been?") a full collection scan.

**Full bitemporal modelling** (valid-time *and* transaction-time — "what did we *believe* on
1 July about who had the truck in June?"). Genuinely useful for finance and insurance
disputes; real complexity in every query. Not warranted here. `updatedAt` plus an audit note
on corrections covers what a fleet actually needs. Revisit only if custody records start
being disputed after the fact.

---

## 10. Edge cases the implementation must handle

| Case | Behaviour |
|---|---|
| Driver exits (`exitDate` set) | Auto-close all open assignments at `exitDate` — otherwise a departed driver holds a truck forever and it can never be reassigned |
| Phone lost/stolen | Close the assignment, set device `status: 'lost'`; it stays out of the assignable pool but its history remains |
| Driver moves country | Snapshot on the new assignment. If they move *without* an asset change, see §12 |
| Backdated assignment | Allowed, but must pass the overlap check in §5 |
| Correcting a mistake | Editing an interval is admin-only and records who changed it; it does not delete the row |
| Asset deleted | Soft-delete only. Snapshots mean history survives either way, but hard-delete breaks the "device life story" view |
| Two drivers, same IMEI (existing data) | Surfaced by the migration as a data error for a human to resolve — never auto-picked |

---

## 11. Evidence

Measurements in §4/§5 are from probes run against an in-memory MongoDB (production
untouched), 6,000 assignment rows across 200 drivers × 15 stints × 2 asset kinds:

```
--- no indexes ---
naive $or                stage=COLLSCAN  returned=446  examined=6000  keys=0     4ms
--- with { startedAt: 1, endedAt: 1 } ---
naive $or                stage=OR        returned=446  examined=506   keys=2225  9ms
--- sentinel + matching index ---
endedAt > from           stage=IXSCAN    returned=446  examined=446   keys=593   3ms

identical result sets: true (446 rows)
```

Invariant probe: second open holder rejected (E11000); reassignment after return succeeds
with both rows retained; second vehicle for the same driver rejected; a mobile alongside a
vehicle allowed.

At your scale (~20 drivers) both forms are fast. The sentinel is chosen because it stays
flat as history accumulates — this collection only ever grows.

---

## 12. Out of scope for v1 (deliberately)

- **Country postings as their own ledger.** If a driver relocates *without* an asset change,
  today's design records nothing. The same interval shape would model it
  (`Posting { driverId, country, startedAt, endedAt }`). Worth adding only if country moves
  routinely happen independently of asset swaps — you'll know from the first month of data.
- **Cost/billing per stint** (`pricePerHour`, `perDiem` already exist on `User`). The
  interval model is exactly what per-day billing needs later; not built now.
- **Utilisation analytics** (idle-asset %, longest-unassigned). Cheap once the ledger exists.

---

## 13. Build order

1. `MobileDevice` model + inventory CRUD + rewire `Mobiles.tsx` (no history yet — the app
   keeps working exactly as today)
2. `Assignment` model, indexes, atomic assign/return, overlap validation, tests
3. Backfill migration, run with `--dry-run` first, output reviewed before writing
4. `GET /api/reports/custody` + `Reports.tsx` monthly view + CSV
5. Driver timeline and device life-story views
6. Drop the six mobile fields from `User` (the one-way door — only after 1–5 are proven)
