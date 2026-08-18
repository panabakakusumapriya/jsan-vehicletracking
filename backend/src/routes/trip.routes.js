const router = require('express').Router();
const ctrl = require('../controllers/trip.controller');
const { authenticate } = require('../middleware/auth');

// Any authenticated role; results are scoped to what the requester may see.
router.use(authenticate);

router.get('/', ctrl.list);
router.get('/export', ctrl.exportBulk);
router.get('/export-merged', ctrl.exportMerged);
router.get('/merged-points', ctrl.mergedPoints);
router.get('/merged-summary', ctrl.mergedSummary);

// Background bulk export. Declared before '/:id' — Express matches in order, so a literal
// path registered after a parameterised one would be swallowed as a trip id.
router.post('/export-jobs', ctrl.createExportJob);
router.get('/export-jobs/:id', ctrl.getExportJob);
router.get('/export-jobs/:id/download', ctrl.downloadExportJob);
router.get('/:id', ctrl.getOne);
router.get('/:id/export', ctrl.exportOne);

module.exports = router;
