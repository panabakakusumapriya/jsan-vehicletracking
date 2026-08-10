const router = require('express').Router();
const ctrl = require('../controllers/courier.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Same audience as Hotels/Weather: whoever is responsible for a driver's day.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));

router.get('/near-driver', ctrl.nearDriver);

module.exports = router;
