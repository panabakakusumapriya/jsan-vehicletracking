const router = require('express').Router();
const ctrl = require('../controllers/academy.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Public: a certificate number is checkable by anyone holding it (printed on the certificate).
router.get('/certificate/:id', ctrl.certificate);

// The course itself is for drivers, with their own app account.
router.get('/course', authenticate, requireRole('user'), ctrl.course);
router.post('/answer', authenticate, requireRole('user'), ctrl.answer);

module.exports = router;
