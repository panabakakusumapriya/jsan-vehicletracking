const router = require('express').Router();
const ctrl = require('../controllers/appVersion.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Public — mobile app checks this on startup
router.get('/current', ctrl.getCurrent);

// Public — mobile app reports its version on every startup
router.post('/report-version', ctrl.reportVersion);

// Admin-only management
router.get('/versions', authenticate, requireRole('admin', 'manager'), ctrl.list);
router.post('/versions', authenticate, requireRole('admin', 'manager'), ctrl.create);
router.patch('/versions/:id', authenticate, requireRole('admin', 'manager'), ctrl.update);
router.delete('/versions/:id', authenticate, requireRole('admin', 'manager'), ctrl.remove);

module.exports = router;
