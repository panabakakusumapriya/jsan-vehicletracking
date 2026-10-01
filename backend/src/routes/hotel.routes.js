const router = require('express').Router();
const ctrl = require('../controllers/hotel.controller');
const bookings = require('../controllers/hotelBooking.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Same audience as the weather tab: whoever is responsible for a driver's day. Drivers
// themselves book through their own channels, so the mobile app does not use this.
router.use(authenticate, requireRole('admin', 'manager', 'team_lead'));

router.get('/near-driver', ctrl.nearDriver);

// Bookings the office has made for drivers — admin side only, never exposed to the driver app.
router.get('/drivers', bookings.drivers);
router.get('/drivers/:id/profile', bookings.driverProfile);
router.get('/bookings', bookings.list);
router.get('/bookings/export.csv', bookings.exportCsv);
router.post('/bookings', bookings.create);
router.patch('/bookings/:id', bookings.update);
router.post('/bookings/:id/attachments', bookings.uploadAttachment);
router.get('/bookings/:id/attachments/:attId', bookings.downloadAttachment);
router.delete('/bookings/:id/attachments/:attId', bookings.deleteAttachment);

module.exports = router;
