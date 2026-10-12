const router = require('express').Router();
const ctrl = require('../controllers/analytics.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// The fleet-wide dashboard: admins and superadmins (requireRole('admin') admits both).
router.get('/overview', authenticate, requireRole('admin'), ctrl.overview);

module.exports = router;
