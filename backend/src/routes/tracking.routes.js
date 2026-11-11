const router = require('express').Router();
const ctrl = require('../controllers/tracking.controller');
const downtimeCtrl = require('../controllers/downtime.controller');
const { authenticate, requireRole } = require('../middleware/auth');

/** No rate limits on the driver's routes (product decision, 2026-11-11). */

// Drivers push their location points.
router.post('/ingest', authenticate, requireRole('user'), ctrl.ingest);

// Driver reads their own active session + GPS trail for the map screen.
router.get('/my-session', authenticate, requireRole('user'), ctrl.mySession);

// Driver reads the work areas they have been allocated.
router.get('/my-areas', authenticate, requireRole('user'), ctrl.myAreas);

// Driver reads the individual roads inside one of those areas, flagged driven / not driven.
router.get('/my-roads', authenticate, requireRole('user'), ctrl.myRoads);

/**
 * No rate limit on the driver's small reads and writes — the map's "has anything changed?" probes,
 * settled trips, the Today card, downtime and Academy progress. A cap shared by all of them let a
 * driver with many areas (Evan Miles, 45) spend it on map probes and lock out the Today card
 * ("Too many map sync requests", 2026-11-11), and the product decision is not to limit them.
 * Each is a small indexed read; the heavy downloads (my-roads, my-history) keep their caps.
 */

// "Has anything changed?" — the cache key alone, no geometry. Kept next to my-roads because
// the two must agree about what a version is.
router.get('/my-roads/version', authenticate, requireRole('user'), ctrl.myRoadsVersion);
// The same for every area the driver holds, in one request — what the app asks from 1.0.27 on.
router.get('/my-roads/versions', authenticate, requireRole('user'), ctrl.myRoadsVersions);

// "Has the server finished these trips?" — by the phone's own trip ids.
router.get('/my-trips/settled', authenticate, requireRole('user'), ctrl.myTripsSettled);

// Driver reads their own route history. Heavy like my-roads (a month of snapped routes), so it
// gets the same kind of per-driver cap; the app caches it and asks a handful of times a day.
router.get('/my-history', authenticate, requireRole('user'), ctrl.myHistory);

// The driver's trips on one day and the day's working hours — a few hundred bytes, no geometry.
router.get('/my-day', authenticate, requireRole('user'), ctrl.myDay);
// Downtime: time stopped for a reason (weather, change-over), counted once a manager approves it.
router.post('/my-downtime', authenticate, requireRole('user'), downtimeCtrl.report);
router.delete('/my-downtime/:id', authenticate, requireRole('user'), downtimeCtrl.withdraw);

// Driver Academy progress (the in-app course) — saved per account.
router.put('/my-academy', authenticate, requireRole('user'), ctrl.myAcademy);

// Admins / managers read the live snapshot.
router.get('/live', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.live);

// The work areas the visible drivers hold, for the live map's "in their area or not".
router.get('/live-areas', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.liveAreas);

// Admins / managers read parked (recently stopped) vehicles.
router.get('/parked', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.parked);

// Unique Kilometers — reads pre-computed edges, no point scan.
router.get('/ukm', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukm);

// Single driver's UKM routes for map view.
router.get('/ukm-driver/:driverId', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukmDriver);

// CSV export of UKM data.
router.get('/ukm-export', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukmExport);

// Explicit, admin-only ledger rebuild. The old '/ukm-backfill' name pointed at the legacy
// per-driver UkmEdge migration, which a dashboard GET used to trigger by itself; both are gone.
router.post('/ukm-rebuild', authenticate, requireRole('admin'), ctrl.ukmRebuild);

module.exports = router;
