const express = require('express');
const adminController = require('../controllers/adminController');
const authController = require('../controllers/authController');
const { requireAdminPage } = require('../middleware/requireAdmin');
const googleController = require('../routes/googleRoutes');
const { adminImageUpload } = require('../config/uploads');
const { optimizeUploadedImage } = require('../middleware/optimizeUploadedImage');
const { authLimiter } = require('../middleware/rateLimiter');
const { authValidation, adminValidation, validateRequest } = require('../middleware/validators');

const router = express.Router();

router.get('/login', authController.renderLogin);
router.post('/login', authLimiter, authValidation.login, validateRequest, authController.adminLogin);
router.post('/logout', authController.adminLogout);

// Protected admin pages
router.use(requireAdminPage);

router.get('/', adminController.renderDashboard);
router.get('/takvim', adminController.renderCalendar);
router.get('/ayarlar', adminController.renderSettings);
router.post('/ayarlar/yasal', adminController.updateLegalSettings);
router.get('/hesap', adminController.renderAccount);
router.post('/hesap', authLimiter, adminValidation.accountUpdate, validateRequest, adminController.updateAccount);
router.get('/google', adminController.renderGoogle);

router.get('/medya', adminController.renderMedia);
router.post('/medya/slot', adminImageUpload.single('file'), optimizeUploadedImage(), adminController.updateMediaSlot);
router.post('/medya/galeri', adminImageUpload.single('file'), optimizeUploadedImage(), adminController.addGalleryItem);
router.post('/medya/galeri/:id', adminImageUpload.single('file'), optimizeUploadedImage(), adminController.updateGalleryItem);
router.post('/medya/galeri/:id/sil', adminController.deleteGalleryItem);

router.get('/inbox', adminController.renderPublicContactInbox);
router.get('/inbox/:id', adminController.renderPublicContactMessageDetail);
router.post('/inbox/:id/status', adminController.updatePublicContactMessageStatus);

// OAuth endpoints
router.use('/google', googleController);

module.exports = router;
