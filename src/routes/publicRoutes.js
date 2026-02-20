const express = require('express');
const pagesController = require('../controllers/pagesController');
const { publicContactLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.get('/', pagesController.renderHome);
router.get('/hakkimizda', pagesController.renderAbout);
router.get('/hizmetler', pagesController.renderServices);
router.get('/ekibimiz', pagesController.renderStaff);
router.get('/galeri', pagesController.renderGallery);
router.get('/iletisim', pagesController.renderContact);
router.post('/iletisim', publicContactLimiter, pagesController.contactPost);
router.get('/randevu', pagesController.renderBookingChoose);
router.get('/randevu/berber', pagesController.renderBookingMen);
router.get('/randevu/guzellik', pagesController.renderBookingWomen);

module.exports = router;
