const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');

// Every handler wrapped, so an error thrown inside one reaches the error middleware as a response.
// Most of these handlers call assertProjectAccess, which THROWS a 403 — unwrapped, that rejection
// went nowhere and the request simply hung until the client gave up.
const ctrl = Object.fromEntries(
  Object.entries(require('../controllers/network.controller')).map(([name, fn]) => [
    name,
    typeof fn === 'function' ? asyncHandler(fn) : fn,
  ])
);
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
// Every road inside a held work area — the "Assigned routes" layer, drawn at any zoom.
router.get('/versions/:id/assigned-links', ctrl.versionAssignedLinks);
// Everyone with driven road on this network, for the map's driver legend.
router.get('/versions/:id/coverage-drivers', ctrl.versionCoverageDrivers);
// Where each driver left off: the last fix of their last drive, and that drive's route. People's
// whereabouts, so the same roles as the live map — not every account on the project.
router.get(
  '/versions/:id/driver-positions',
  requireRole('admin', 'manager', 'team_lead'),
  ctrl.versionDriverPositions
);
router.get(
  '/versions/:id/driver-positions/route',
  requireRole('admin', 'manager', 'team_lead'),
  ctrl.versionDriverRoute
);
// Every road at full detail as cached binary files, and which of them are driven (roadBlobs.js).
router.get('/versions/:id/road-blobs', ctrl.versionRoadBlobs);
router.get('/road-blob/:versionId/:key', ctrl.roadBlob);
router.get('/versions/:id/road-state', ctrl.versionRoadState);
// Snapped driven routes across the project, for the map's "Driven tracks" layer.
router.get('/versions/:id/tracks', ctrl.versionTracks);
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

/* ---- is this area finished? the manager's verdict, not a computed threshold ---- */
// Everything the click-a-polygon panel shows: totals, the per-driver split, who holds it.
router.get('/versions/:id/areas/:areaId/coverage', ctrl.areaCoverage);
router.post(
  '/versions/:id/areas/:areaId/complete',
  requireRole('admin', 'manager'),
  ctrl.completeArea
);
router.post(
  '/versions/:id/areas/:areaId/reopen',
  requireRole('admin', 'manager'),
  ctrl.reopenArea
);
// Wipe an area's driven data so it can be driven again from zero (services/coverageReset.js).
router.post(
  '/versions/:id/areas/:areaId/clear-coverage',
  requireRole('admin', 'manager'),
  ctrl.clearAreaCoverage
);

// An area too big for one driver, cut into zones of a size the manager chooses — and put back.
router.post(
  '/versions/:id/areas/:areaId/split',
  requireRole('admin', 'manager'),
  ctrl.splitArea
);
router.post(
  '/versions/:id/areas/:areaId/join',
  requireRole('admin', 'manager'),
  ctrl.joinArea
);

router.delete('/versions/:id', requireRole('admin'), ctrl.deleteVersion);
// Name a delivery and say where it is — what the coverage page's region filter reads.
router.patch('/versions/:id', requireRole('admin', 'manager'), ctrl.updateVersion);

module.exports = router;
