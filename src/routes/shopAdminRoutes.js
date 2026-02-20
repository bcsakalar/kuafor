const express = require('express');
const shopAdminController = require('../controllers/shopAdminController');
const { shopImageUpload, shopBulkUpload, normalizeUploadError } = require('../config/uploads');
const { optimizeUploadedImage } = require('../middleware/optimizeUploadedImage');
const { authLimiter, orderSearchLimiter } = require('../middleware/rateLimiter');
const { authValidation, validateRequest } = require('../middleware/validators');

const router = express.Router();

function getSafeProductsReturnPath(req, fallbackPath = '/products') {
	try {
		const ref = String(req && req.headers ? (req.headers.referer || req.headers.referrer || '') : '').trim();
		if (!ref) return fallbackPath;
		const u = new URL(ref, 'http://localhost');
		const path = `${u.pathname || ''}${u.search || ''}`;
		if (path.startsWith('/products')) return path;
		return fallbackPath;
	} catch {
		return fallbackPath;
	}
}

function shopUploadSingle(fieldName) {
	return (req, res, next) => {
		shopImageUpload.single(fieldName)(req, res, (err) => {
			if (!err) return next();
			const uploadErr = normalizeUploadError(err);
			const code = uploadErr?.code || 'upload_error';
			const backTo = getSafeProductsReturnPath(req, '/products');
			const join = backTo.includes('?') ? '&' : '?';
			return res.redirect(`${backTo}${join}err=${encodeURIComponent(code)}`);
		});
	};
}

function shopUploadBulk(fieldName) {
	return (req, res, next) => {
		shopBulkUpload.single(fieldName)(req, res, (err) => {
			if (!err) return next();
			const uploadErr = normalizeUploadError(err);
			const code = uploadErr?.code || 'upload_error';
			const backTo = getSafeProductsReturnPath(req, '/products');
			const join = backTo.includes('?') ? '&' : '?';
			return res.redirect(`${backTo}${join}bulk_err=${encodeURIComponent(code)}`);
		});
	};
}

router.get('/login', shopAdminController.renderLogin);
router.post('/login', authLimiter, authValidation.login, validateRequest, shopAdminController.login);
router.post('/logout', shopAdminController.logout);

router.use(shopAdminController.requireShopAdminPage);

router.get('/', shopAdminController.renderDashboard);
router.get('/products', shopAdminController.renderProducts);
router.get('/products/bulk-template', shopAdminController.downloadBulkProductsTemplate);
router.get('/products/:id', shopAdminController.renderProductDetail);
router.post('/categories', shopAdminController.createCategory);
router.post('/categories/:id/delete', shopAdminController.deleteCategory);
router.post('/products', shopUploadSingle('image'), optimizeUploadedImage(), shopAdminController.createProduct);
router.post('/products/bulk-upload', shopUploadBulk('file'), shopAdminController.bulkUpsertProducts);
router.post('/products/:id/update', shopUploadSingle('image'), optimizeUploadedImage(), shopAdminController.updateProduct);
router.post('/products/:id/adjust-stock', shopAdminController.adjustProductStock);
router.post('/products/:id/delete', shopAdminController.deleteProduct);
router.post('/products/:id/toggle', shopAdminController.toggleProduct);

router.get('/orders', shopAdminController.renderOrders);
router.get('/orders/export', shopAdminController.exportOrders);
router.get('/orders/:id', shopAdminController.renderOrderDetail);
router.post('/orders/:id/status', shopAdminController.updateOrderStatus);
router.post('/orders/:id/refund', shopAdminController.refundOrder);
router.post('/orders/:id/cancel-and-refund', shopAdminController.cancelAndRefundOrder);

// API routes for advanced features
router.get('/api/orders/search', orderSearchLimiter, shopAdminController.searchOrdersApi);
router.get('/api/analytics/payments', shopAdminController.getPaymentReportApi);
router.get('/api/analytics/advanced', shopAdminController.getAdvancedAnalyticsApi);

router.get('/inbox', shopAdminController.renderContactInbox);
router.get('/inbox/:id', shopAdminController.renderContactMessageDetail);
router.post('/inbox/:id/status', shopAdminController.updateContactMessageStatus);

router.get('/cancellation-requests', shopAdminController.renderCancellationRequests);
router.post('/cancellation-requests/:id/approve', shopAdminController.approveCancellationRequest);
router.post('/cancellation-requests/:id/reject', shopAdminController.rejectCancellationRequest);

module.exports = router;
