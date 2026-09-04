const router = require('express').Router();
const ctrl = require('../controllers/marker.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// Categories: everyone signed in may read (the driver picker needs them); admins manage.
router.get('/categories', ctrl.listCategories);
router.post('/categories', requireRole('admin'), ctrl.createCategory);
router.patch('/categories/:id', requireRole('admin'), ctrl.updateCategory);
router.delete('/categories/:id', requireRole('admin'), ctrl.deleteCategory);

// Markers: drivers drop and see their own; staff review across the drivers they can see.
router.post('/', requireRole('user'), ctrl.create);
router.get('/mine', requireRole('user'), ctrl.mine);
router.get('/', requireRole('admin', 'manager', 'team_lead'), ctrl.list);
router.delete('/:id', requireRole('admin'), ctrl.remove);

module.exports = router;
