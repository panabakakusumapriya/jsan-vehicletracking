const router = require('express').Router();
const ctrl = require('../controllers/tracking.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Drivers push their location points.
router.post('/ingest', authenticate, requireRole('user'), ctrl.ingest);

// Admins / managers read the live snapshot.
router.get('/live', authenticate, requireRole('admin', 'manager'), ctrl.live);

module.exports = router;
