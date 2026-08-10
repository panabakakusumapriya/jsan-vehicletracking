const router = require('express').Router();
const ctrl = require('../controllers/appActivity.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Heartbeat — called by the mobile app (drivers)
router.post('/heartbeat', authenticate, requireRole('user'), ctrl.heartbeat);

// Admin/manager dashboard
router.get('/', authenticate, requireRole('admin', 'manager', 'team_lead'), ctrl.list);

module.exports = router;
