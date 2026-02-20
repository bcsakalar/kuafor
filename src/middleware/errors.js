const { logger } = require('../config/logger');

function notFoundHandler(req, res, _next) {
	const adminBasePath = (typeof req.adminBasePath === 'string') ? req.adminBasePath : '/admin';
	const adminApiBasePath = (typeof req.adminApiBasePath === 'string') ? req.adminApiBasePath : `${adminBasePath}/api`;
	const wantsJson =
		req.path.startsWith('/admin/api') ||
		req.path.startsWith(adminApiBasePath) ||
		req.path.startsWith('/booking/api') ||
		String(req.headers.accept || '').includes('application/json');

	logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`, {
		ip: req.ip,
		userAgent: req.get('user-agent'),
	});

	if (wantsJson) {
		return res.status(404).json({ message: 'Not found' });
	}

	res.status(404);
	if (req.isShopAdminHost) {
		return res.render('pages/404', { title: 'Bulunamadı', layout: 'layouts/shopAdmin' });
	}
	if (req.isShopHost) {
		return res.render('pages/404', { title: 'Bulunamadı', layout: 'layouts/shop' });
	}
	if (req.isAdminContext) {
		return res.render('admin/404', { title: 'Bulunamadı', layout: 'layouts/admin' });
	}
	return res.render('pages/404', { title: 'Bulunamadı' });
}

function normalizeUploadError(err) {
	const { normalizeUploadError: normalize } = require('../config/uploads');
	return normalize(err);
}

function getHumanMessageForCode(code) {
	const { getHumanMessageForUploadCode } = require('../config/uploads');
	return getHumanMessageForUploadCode(code);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
	const uploadErr = normalizeUploadError(err);
	const statusCode = Number(uploadErr?.statusCode || err.statusCode || err.status || 500);
	const adminBasePath = (typeof req.adminBasePath === 'string') ? req.adminBasePath : '/admin';
	const adminApiBasePath = (typeof req.adminApiBasePath === 'string') ? req.adminApiBasePath : `${adminBasePath}/api`;
	const wantsJson =
		req.path.startsWith('/admin/api') ||
		req.path.startsWith(adminApiBasePath) ||
		req.path.startsWith('/booking/api') ||
		String(req.headers.accept || '').includes('application/json');

	// Hataları Winston ile logla
	const errorId = Date.now();
	const userId = req.user?._id || req.session?.userId;
	logger.error(`Error [${errorId}]: ${err.message}`, {
		errorId,
		statusCode,
		message: err.message,
		stack: err.stack,
		requestPath: req.originalUrl,
		requestMethod: req.method,
		userId,
		ip: req.ip,
		userAgent: req.get('user-agent'),
	});

	// For admin media form posts, prefer redirecting back with a readable error instead of a generic 500 page.
	if (!wantsJson && uploadErr && (req.path.startsWith(`${adminBasePath}/medya`) || (adminBasePath === '' && req.path.startsWith('/medya')))) {
		const url = (adminBasePath ? `${adminBasePath}/medya` : '/medya');
		return res.redirect(`${url}?err=${encodeURIComponent(uploadErr.code)}`);
	}

	if (wantsJson) {
		if (uploadErr) {
			return res.status(statusCode).json({
				message: getHumanMessageForCode(uploadErr.code) || 'Upload error',
				code: uploadErr.code,
			});
		}
		const payload = {
			message: err.message || 'Server error',
		};
		if (err.details) payload.details = err.details;
		return res.status(statusCode).json(payload);
	}

	res.status(statusCode);
	if (req.isShopAdminHost) {
		return res.render('pages/500', { title: 'Hata', layout: 'layouts/shopAdmin', errorId });
	}
	if (req.isShopHost) {
		return res.render('pages/500', { title: 'Hata', layout: 'layouts/shop', errorId });
	}
	if (req.isAdminContext) {
		return res.render('admin/500', { title: 'Hata', layout: 'layouts/admin', errorId });
	}
	return res.render('pages/500', { title: 'Hata', errorId });
}

module.exports = { notFoundHandler, errorHandler };
