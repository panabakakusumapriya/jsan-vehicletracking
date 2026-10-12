const router = require('express').Router();
const ctrl = require('../controllers/analytics.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// The fleet-wide dashboard: superadmins only.
router.get('/overview', authenticate, requireRole('superadmin'), ctrl.overview);

module.exports = router;
