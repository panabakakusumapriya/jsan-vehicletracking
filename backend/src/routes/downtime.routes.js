const router = require('express').Router();
const ctrl = require('../controllers/downtime.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Drivers report downtime from the app (routes/tracking.routes.js); it counts at once. Staff can
// list it for the drivers they can see (the Trips page shows it among each day's trips).
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));
router.get('/', ctrl.list);

module.exports = router;
