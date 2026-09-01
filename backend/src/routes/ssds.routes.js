const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = require('express').Router();
const ctrl = require('../controllers/ssds.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const { isS3Configured, uploadToS3 } = require('../config/s3');

// Multer: memory storage when S3 is configured, disk fallback for local dev
const localDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'ssd');
const ssdUpload = multer({
  storage: isS3Configured()
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
          fs.mkdirSync(localDir, { recursive: true });
          cb(null, localDir);
        },
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '.jpg';
          cb(null, `ssd_${req.user._id}_${Date.now()}${ext}`);
        },
      }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// Image proxy — before auth so <img src> tags work (S3 keys are unguessable)
router.get('/image/:key(*)', ctrl.getImage);

// All other SSDS routes require authentication
router.use(authenticate);

// ── Driver portal (role: user) ──
// Drivers see only their own records, matched by email.
router.get('/my/ssds', ctrl.myDriverSsds);
router.post('/my/ssds', ssdUpload.single('ssdImage'), ctrl.createMySsds);
router.patch('/my/ssds/:id', ctrl.updateMySsds);
router.patch('/my/ssds', ctrl.updateMySsds);
router.get('/my/timesheets', ctrl.myDriverTimesheets);
router.get('/my/daily-reports', ctrl.myDriverDailyReports);
router.get('/my/cor', ctrl.myCor);
router.post('/my/cor', ctrl.createCor);

// ── Admin/Manager portal ──
// Everything below requires admin/manager/team_lead.
const adminManagerTl = requireRole('admin', 'manager', 'team_lead');
const adminManager = requireRole('admin', 'manager');

// SSDS Portal (drivers collection)
router.get('/ssds', adminManagerTl, ctrl.getSsds);
router.get('/ssds/export', adminManagerTl, ctrl.exportSsds);
router.get('/ssds/history', adminManagerTl, ctrl.getSsdsHistory);
router.post('/ssds', adminManager, ssdUpload.single('ssdImage'), ctrl.createDriver);
router.patch('/ssds/:id', adminManager, ctrl.updateDriver);
router.delete('/ssds/:id', adminManager, ctrl.deleteDriver);

// Timesheets
router.get('/timesheets', adminManagerTl, ctrl.getTimesheets);
router.get('/timesheets/export', adminManagerTl, ctrl.exportTimesheets);
router.post('/timesheets', adminManager, ctrl.createTimesheet);
router.patch('/timesheets/:id', adminManager, ctrl.updateTimesheet);
router.delete('/timesheets/:id', adminManager, ctrl.deleteTimesheet);

// Daily Reports
router.get('/daily-reports', adminManagerTl, ctrl.getDailyReports);
router.get('/daily-reports/export', adminManagerTl, ctrl.exportDailyReports);
router.post('/daily-reports', adminManager, ctrl.createDailyReport);
router.patch('/daily-reports/:id', adminManager, ctrl.updateDailyReport);
router.delete('/daily-reports/:id', adminManager, ctrl.deleteDailyReport);

// COR — admin/manager view across all drivers (project-scoped)
router.get('/cor', adminManagerTl, ctrl.getAllCor);

// Assign project to SSDS records (admin + manager)
router.patch('/assign-project', adminManager, ctrl.assignProject);

module.exports = router;
