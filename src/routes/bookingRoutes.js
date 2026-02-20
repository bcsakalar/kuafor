const express = require('express');
const bookingController = require('../controllers/bookingController');
const { bookingValidation, validateRequest } = require('../middleware/validators');
const { bookingLimiter, bookingAvailabilityLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Servis ve personel listesi (düşük risk - sadece okuma)
router.get('/api/services', bookingController.validateCategory, bookingController.apiListServices);
router.get('/api/staff', bookingController.validateCategory, bookingController.apiListStaff);

// Müsaitlik kontrolü (orta risk - rate limit uygula)
router.get('/api/availability', bookingAvailabilityLimiter, bookingController.validateAvailability, bookingController.apiCheckAvailability);

// Randevu oluşturma (yüksek risk - sıkı rate limit)
router.post('/api', bookingLimiter, bookingValidation.create, validateRequest, bookingController.apiCreateBooking);

module.exports = router;
