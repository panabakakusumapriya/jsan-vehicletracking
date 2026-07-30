const router = require('express').Router();
const ctrl = require('../controllers/assignment.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin', 'manager'));

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/driver/:driverId', ctrl.forDriver);
router.post('/:id/return', ctrl.release);

module.exports = router;
