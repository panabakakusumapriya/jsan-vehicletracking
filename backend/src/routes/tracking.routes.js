const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/tracking.controller');
const { authenticate, requireRole } = require('../middleware/auth');

/**
 * my-roads is the one route here that is genuinely expensive: up to 20,000 documents read out of a
 * 654k-link collection, simplified, and gzipped into ~2.5 MB of JSON, all on a single-process API
 * that is also carrying live ingest. A client stuck in a retry loop — a bad release, a driver
 * force-quitting the map over and over — would starve the ingest path and take live tracking down
 * for the whole fleet, so the cap is here rather than in the app where it can be shipped away.
 *
 * Keyed by driver, NOT by IP: mobile carriers put thousands of handsets behind one NAT address, so
 * the default IP key would have one busy driver lock out every other driver on the same network.
 * Safe to read req.user because `authenticate` runs before this on the route.
 *
 * 120 per 15 minutes is ~1 every 7.5s sustained. A client that honours `version` does a handful a
 * day, so this only bites something that is already misbehaving.
 */
const roadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => (req.user ? String(req.user._id) : req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many road-layer requests; try again shortly' },
});

// Drivers push their location points.
router.post('/ingest', authenticate, requireRole('user'), ctrl.ingest);

// Driver reads their own active session + GPS trail for the map screen.
router.get('/my-session', authenticate, requireRole('user'), ctrl.mySession);

// Driver reads the work areas they have been allocated.
router.get('/my-areas', authenticate, requireRole('user'), ctrl.myAreas);

// Driver reads the individual roads inside one of those areas, flagged driven / not driven.
router.get('/my-roads', authenticate, requireRole('user'), roadsLimiter, ctrl.myRoads);

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
