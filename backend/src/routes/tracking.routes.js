const router = require('express').Router();
const ctrl = require('../controllers/tracking.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Drivers push their location points.
router.post('/ingest', authenticate, requireRole('user'), ctrl.ingest);

// Driver reads their own active session + GPS trail for the map screen.
router.get('/my-session', authenticate, requireRole('user'), ctrl.mySession);

// Admins / managers read the live snapshot.
router.get('/live', authenticate, requireRole('admin', 'manager'), ctrl.live);

// Admins / managers read parked (recently stopped) vehicles.
router.get('/parked', authenticate, requireRole('admin', 'manager'), ctrl.parked);

module.exports = router;
