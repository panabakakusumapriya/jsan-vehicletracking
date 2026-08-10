const router = require('express').Router();
const ctrl = require('../controllers/weather.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Team leads see the weather for their own drivers — accessibleDriverFilter already scopes
// them, so they get their slice and nobody else's.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));

router.get('/driving', ctrl.driving);
router.get('/trip-history', ctrl.tripHistory);
router.get('/trip-weather/:id', ctrl.tripWeather);

module.exports = router;
