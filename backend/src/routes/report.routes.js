const router = require('express').Router();
const ctrl = require('../controllers/report.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));

router.get('/custody', ctrl.custody);
router.get('/custody.csv', ctrl.custodyCsv);

module.exports = router;
