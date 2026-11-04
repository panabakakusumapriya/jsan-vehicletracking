const router = require('express').Router();
const ctrl = require('../controllers/downtime.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Drivers report downtime from the app (routes/tracking.routes.js); here staff review it, for the
// drivers they can see.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));
router.get('/', ctrl.list);
router.patch('/:id', ctrl.review);

module.exports = router;
