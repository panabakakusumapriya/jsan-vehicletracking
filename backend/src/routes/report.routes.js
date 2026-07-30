const router = require('express').Router();
const ctrl = require('../controllers/report.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin', 'manager'));

router.get('/custody', ctrl.custody);
router.get('/custody.csv', ctrl.custodyCsv);

module.exports = router;
