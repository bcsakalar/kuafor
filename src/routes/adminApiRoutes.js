const express = require('express');
const adminApi = require('../controllers/adminApiController');
const { requireAdminApi } = require('../middleware/requireAdmin');

const router = express.Router();

router.use(requireAdminApi);

router.post('/services', adminApi.validateUpsertService, adminApi.upsertService);
router.delete('/services/:id', adminApi.validateDeleteService, adminApi.deleteService);

router.post('/staff', adminApi.validateCreateStaff, adminApi.createStaff);
router.put('/staff/:id', adminApi.validateUpdateStaff, adminApi.updateStaff);
router.delete('/staff/:id', adminApi.validateDeleteStaff, adminApi.deleteStaff);

router.get('/staff', adminApi.validateListStaff, adminApi.listStaff);

router.get('/appointments', adminApi.listAppointments);
router.get('/appointments/:id', adminApi.validateGetAppointmentById, adminApi.getAppointmentById);

router.put('/appointments/:id', adminApi.validateUpdateAppointment, adminApi.updateAppointment);
router.delete('/appointments/:id', adminApi.validateCancelAppointment, adminApi.cancelAppointment);

router.get('/hours', adminApi.validateGetHours, adminApi.getHours);
router.post('/hours', adminApi.validateUpsertHours, adminApi.upsertHours);

router.get('/overrides', adminApi.validateListOverrides, adminApi.listOverrides);
router.post('/overrides', adminApi.validateUpsertOverride, adminApi.upsertOverride);
router.delete('/overrides/:id', adminApi.validateDeleteOverride, adminApi.deleteOverride);

router.get('/contact', adminApi.validateGetContact, adminApi.getContact);
router.post('/contact', adminApi.validateUpsertContact, adminApi.upsertContact);

router.get('/google/status', adminApi.googleStatus);
router.post('/google/disconnect', adminApi.googleDisconnect);

module.exports = router;
