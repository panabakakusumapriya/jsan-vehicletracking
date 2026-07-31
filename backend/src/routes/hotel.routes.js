const router = require('express').Router();
const ctrl = require('../controllers/hotel.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Same audience as the weather tab: whoever is responsible for a driver's day. Drivers
// themselves book through their own channels, so the mobile app does not use this.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));

router.get('/near-driver', ctrl.nearDriver);

module.exports = router;
