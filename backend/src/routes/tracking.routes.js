const router = require('express').Router();
const ctrl = require('../controllers/tracking.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Drivers push their location points.
router.post('/ingest', authenticate, requireRole('user'), ctrl.ingest);

// Driver reads their own active session + GPS trail for the map screen.
router.get('/my-session', authenticate, requireRole('user'), ctrl.mySession);

// Driver reads the work areas they have been allocated.
router.get('/my-areas', authenticate, requireRole('user'), ctrl.myAreas);

// Admins / managers read the live snapshot.
router.get('/live', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.live);

// Admins / managers read parked (recently stopped) vehicles.
router.get('/parked', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.parked);

// Unique Kilometers — reads pre-computed edges, no point scan.
router.get('/ukm', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukm);

// Single driver's UKM routes for map view.
router.get('/ukm-driver/:driverId', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukmDriver);

// CSV export of UKM data.
router.get('/ukm-export', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.ukmExport);

// One-time backfill of UKM edges for historical trips.
router.post('/ukm-backfill', authenticate, requireRole('admin'), ctrl.ukmBackfill);

module.exports = router;
