const router = require('express').Router();
const ctrl = require('../controllers/trip.controller');
const { authenticate } = require('../middleware/auth');

// Any authenticated role; results are scoped to what the requester may see.
router.use(authenticate);

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);

module.exports = router;
