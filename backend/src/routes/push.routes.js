const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/push.controller');

const router = express.Router();

// The test button is user-triggered; keep it from becoming a self-spam button.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

// Public: the browser needs the VAPID public key before it can subscribe.
router.get('/public-key', ctrl.getPublicKey);

// Alerts are a panel feature — drivers use the mobile app and never subscribe here.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));
router.post('/subscribe', ctrl.subscribe);
router.post('/unsubscribe', ctrl.unsubscribe);
router.post('/test', testLimiter, ctrl.test);

module.exports = router;
