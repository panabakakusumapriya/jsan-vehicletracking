const router = require('express').Router();
const ctrl = require('../controllers/network.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

/* ---- import jobs: uploading and approving a customer delivery ---- */
router.get('/imports', ctrl.listJobs);
router.post('/imports', requireRole('admin', 'manager'), ctrl.createJob);
router.get('/imports/:id', ctrl.getJob);
// Work areas straight off the extracted shapefile, before anything is committed.
router.get('/imports/:id/preview.geojson', ctrl.importPreviewGeoJson);
// Raw zip body, streamed to disk — see the controller for why this is not multipart.
router.post('/imports/:id/file', requireRole('admin', 'manager'), ctrl.uploadLayer);
router.patch('/imports/:id', requireRole('admin', 'manager'), ctrl.updateJob);
router.post('/imports/:id/validate', requireRole('admin', 'manager'), ctrl.validateJob);
router.post('/imports/:id/commit', requireRole('admin', 'manager'), ctrl.commitJob);
router.delete('/imports/:id', requireRole('admin', 'manager'), ctrl.deleteJob);

/* ---- committed versions: the target network and progress against it ---- */
router.get('/versions', ctrl.listVersions);
router.get('/versions/:id', ctrl.versionSummary);
router.get('/versions/:id/areas', ctrl.versionAreas);
// Simplified outlines + per-area coverage, for the WebGL choropleth.
router.get('/versions/:id/areas.geojson', ctrl.versionAreasGeoJson);
router.get('/versions/:id/links', ctrl.versionLinks);
router.post('/versions/:id/activate', requireRole('admin', 'manager'), ctrl.activateVersion);

/* ---- who is responsible for which work area ---- */
router.get('/versions/:id/assignments', ctrl.listAssignments);
// Many areas at once — what selecting a cluster on the map produces.
router.put(
  '/versions/:id/assignments',
  requireRole('admin', 'manager', 'team_lead'),
  ctrl.bulkAssign
);
router.put(
  '/versions/:id/areas/:areaId/assignments',
  requireRole('admin', 'manager', 'team_lead'),
  ctrl.setAreaAssignments
);
router.get('/areas/:areaId/assignments/history', ctrl.areaAssignmentHistory);
router.delete('/versions/:id', requireRole('admin'), ctrl.deleteVersion);

module.exports = router;
