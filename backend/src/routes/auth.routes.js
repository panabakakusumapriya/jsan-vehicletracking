const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

router.post('/login', loginLimiter, ctrl.login);
router.post('/logout', authenticate, ctrl.logout);
router.get('/me', authenticate, ctrl.me);

module.exports = router;
