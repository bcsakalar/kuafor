const { body, validationResult } = require('express-validator');

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatErrors(resultArray) {
	return resultArray.map((e) => ({
		field: e.path,
		message: e.msg,
	}));
}

function validateRequest(req, res, next) {
	const result = validationResult(req);
	if (result.isEmpty()) return next();

	const errors = formatErrors(result.array({ onlyFirstError: true }));
	const errorText = errors.map((e) => String(e.message)).filter(Boolean).join(' ');
	const fullPath = `${String(req.baseUrl || '')}${String(req.path || '')}`;
	const accept = String(req.headers.accept || '');
	const contentType = String(req.headers['content-type'] || '');
	const wantsJson =
		fullPath.startsWith('/api') ||
		fullPath.startsWith('/admin/api') ||
		fullPath.startsWith('/booking/api') ||
		accept.includes('application/json') ||
		contentType.includes('application/json') ||
		req.xhr;

	if (wantsJson) {
		return res.status(400).json({ message: 'Validation failed', errors });
	}

	// For common HTML form posts, render the original page with a 400 status.
	// This preserves the "400" requirement while keeping UX consistent.
	try {
		const method = String(req.method || '').toUpperCase();
		const path = String(req.path || '');
		const nextUrl = sanitizeNextUrl(req.body?.next || req.query?.next);

		if (method === 'POST' && req.isShopHost && path === '/login') {
			return res.status(400).render('shop/login', {
				title: 'Giriş Yap',
				layout: 'layouts/shop',
				error: errorText || 'Geçersiz giriş bilgileri.',
				nextUrl,
			});
		}
		if (method === 'POST' && req.isShopHost && path === '/register') {
			return res.status(400).render('shop/register', {
				title: 'Kayıt Ol',
				layout: 'layouts/shop',
				error: errorText || 'Geçersiz kayıt bilgileri.',
				nextUrl,
			});
		}
		if (method === 'POST' && req.isAdminContext && path === '/login') {
			return res.status(400).render('admin/login', {
				title: 'Admin Giriş',
				layout: 'layouts/admin',
				hideAdminNav: true,
				error: errorText || 'Geçersiz giriş bilgileri.',
				success: null,
			});
		}
		if (method === 'POST' && req.isShopAdminHost && path === '/login') {
			return res.status(400).render('shopAdmin/login', {
				title: 'Shop Admin Giriş',
				layout: 'layouts/shopAdmin',
				hideAdminNav: true,
				hideShopAdminNav: true,
				error: errorText || 'Geçersiz giriş bilgileri.',
			});
		}
		if (method === 'POST' && req.isShopHost && path === '/iletisim') {
			return res.status(400).render('shop/contact', {
				title: 'İletişim',
				layout: 'layouts/shop',
				error: errorText || 'Form bilgileri geçersiz.',
				success: null,
				form: {
					fullName: String(req.body?.fullName || ''),
					email: String(req.body?.email || ''),
					phone: String(req.body?.phone || ''),
					subject: String(req.body?.subject || ''),
					message: String(req.body?.message || ''),
				},
			});
		}
	} catch {
		// Fall back to plain HTML below.
	}

	const list = errors
		.map((e) => `<li><strong>${escapeHtml(e.field)}</strong>: ${escapeHtml(e.message)}</li>`)
		.join('');
	return res.status(400).send(`<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Validation failed</title></head><body><h1>Validation failed</h1><ul>${list}</ul></body></html>`);
}

function sanitizeTurkishPhoneToDigits(value) {
	if (value == null) return '';
	return String(value).trim().replace(/[^0-9]/g, '');
}

function sanitizeNextUrl(value) {
	const raw = String(value == null ? '' : value).trim();
	if (!raw) return '/';
	// Only allow relative paths like "/foo". Block protocol-relative ("//") and absolute URLs.
	if (!raw.startsWith('/')) return '/';
	if (raw.startsWith('//')) return '/';
	if (raw.includes('://')) return '/';
	if (raw.includes('\\')) return '/';
	return raw.slice(0, 500);
}

const authValidation = {
	register: [
		body('next')
			.optional({ nullable: true })
			.customSanitizer(sanitizeNextUrl),
		body('fullName')
			.notEmpty().withMessage('Ad Soyad boş olamaz')
			.isString().withMessage('Ad Soyad geçersiz')
			.isLength({ min: 2, max: 200 }).withMessage('Ad Soyad 2-200 karakter olmalı')
			.trim()
			.escape(),
		body('email')
			.notEmpty().withMessage('E-posta boş olamaz')
			.isEmail().withMessage('Geçerli bir e-posta girin')
			.normalizeEmail(),
		body('password')
			.notEmpty().withMessage('Şifre boş olamaz')
			.isLength({ min: 6, max: 200 }).withMessage('Şifre en az 6 karakter olmalı'),
		body('phone')
			.notEmpty().withMessage('Telefon boş olamaz')
			.customSanitizer(sanitizeTurkishPhoneToDigits)
			.custom((value) => /^\d+$/.test(String(value))).withMessage('Telefon sadece sayısal olmalı')
			.custom((value) => {
				const digits = String(value);
				// TR: typically 10 (without 0) or 11 (with 0). Allow up to 15 for international.
				return digits.length >= 10 && digits.length <= 15;
			}).withMessage('Telefon formatı geçersiz'),
	],
	login: [
		body('next')
			.optional({ nullable: true })
			.customSanitizer(sanitizeNextUrl),
		body('email')
			.notEmpty().withMessage('E-posta boş olamaz')
			.isEmail().withMessage('Geçerli bir e-posta girin')
			.normalizeEmail(),
		body('password')
			.notEmpty().withMessage('Şifre boş olamaz')
			.isString().withMessage('Şifre geçersiz')
			.isLength({ min: 6, max: 200 }).withMessage('Şifre en az 6 karakter olmalı'),
	],
};

const adminValidation = {
	accountUpdate: [
		body('email')
			.customSanitizer((value) => {
				// IMPORTANT: validator.normalizeEmail('') returns '@'.
				// We trim first and then treat empty-as-missing so email updates are truly optional.
				if (value == null) return '';
				return String(value).trim();
			})
			.optional({ nullable: true, checkFalsy: true })
			.custom((value) => {
				// allow blank (means no change)
				if (!value) return true;
				return String(value).length <= 200;
			}).withMessage('E-posta en fazla 200 karakter olmalı')
			.custom((value) => {
				if (!value) return true;
				// express-validator's isEmail can be too permissive with whitespace; we trimmed above.
				return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
			}).withMessage('Geçerli bir e-posta girin')
			.normalizeEmail(),
		body('newPassword')
			.optional({ nullable: true })
			.isLength({ max: 200 }).withMessage('Şifre en fazla 200 karakter olmalı')
			.custom((value) => {
				if (!value) return true;
				return String(value).length >= 6;
			}).withMessage('Yeni şifre en az 6 karakter olmalı'),
		body('newPasswordConfirm')
			.optional({ nullable: true })
			.custom((value, { req }) => {
				const pw = String(req.body?.newPassword || '');
				if (!pw) return true;
				return String(value || '') === pw;
			}).withMessage('Yeni şifreler eşleşmiyor'),
		body('currentPassword')
			.notEmpty().withMessage('Mevcut şifre zorunlu')
			.isString().withMessage('Mevcut şifre geçersiz')
			.isLength({ min: 6, max: 200 }).withMessage('Mevcut şifre geçersiz'),
		body().custom((value, { req }) => {
			const email = String(req.body?.email || '').trim();
			const newPassword = String(req.body?.newPassword || '');
			if (!email && !newPassword) {
				throw new Error('E-posta veya yeni şifre girin');
			}
			return true;
		}),
	],
};

const bookingValidation = {
	create: [
		// Backward/alternative fields (kept optional)
		body('date')
			.optional({ nullable: true })
			.isISO8601({ strict: true }).withMessage('Tarih formatı geçersiz'),
		body('time')
			.optional({ nullable: true })
			.matches(/^([01]\d|2[0-3]):[0-5]\d$/).withMessage('Saat formatı geçersiz'),
		body('serviceId')
			.optional({ nullable: true })
			.isInt({ min: 1 }).withMessage('Hizmet ID sayısal olmalı'),

		// Actual booking API payload
		body('category')
			.notEmpty().withMessage('Kategori boş olamaz')
			.isIn(['men', 'women']).withMessage('Kategori geçersiz'),
		body('serviceIds')
			.isArray({ min: 1 }).withMessage('En az 1 hizmet seçilmeli'),
		body('serviceIds.*')
			.isUUID().withMessage('Hizmet ID formatı geçersiz'),
		body('staffId')
			.optional({ nullable: true })
			.isUUID().withMessage('Personel ID formatı geçersiz'),
		body('startsAt')
			.notEmpty().withMessage('Tarih/saat boş olamaz')
			.isISO8601({ strict: true }).withMessage('Tarih/saat formatı geçersiz'),
		body('customerFullName')
			.notEmpty().withMessage('Ad Soyad boş olamaz')
			.isString().withMessage('Ad Soyad geçersiz')
			.isLength({ min: 2, max: 80 }).withMessage('Ad Soyad 2-80 karakter olmalı')
			.trim()
			.escape(),
		body('customerPhone')
			.notEmpty().withMessage('Telefon boş olamaz')
			.customSanitizer(sanitizeTurkishPhoneToDigits)
			.custom((value) => /^\d+$/.test(String(value))).withMessage('Telefon sadece sayısal olmalı')
			.custom((value) => {
				const digits = String(value);
				return digits.length >= 10 && digits.length <= 15;
			}).withMessage('Telefon formatı geçersiz'),
		body('customerEmail')
			.optional({ nullable: true })
			.isEmail().withMessage('E-posta formatı geçersiz')
			.normalizeEmail(),
		body('notes')
			.optional({ nullable: true })
			.isString().withMessage('Not geçersiz')
			.isLength({ max: 500 }).withMessage('Not en fazla 500 karakter olmalı')
			.trim()
			.escape(),
	],
};

const shopValidation = {
	contact: [
		body('fullName')
			.optional({ nullable: true })
			.isString().withMessage('Ad Soyad geçersiz')
			.isLength({ max: 200 }).withMessage('Ad Soyad en fazla 200 karakter olmalı')
			.trim()
			.escape(),
		body('email')
			.notEmpty().withMessage('E-posta boş olamaz')
			.isEmail().withMessage('Geçerli bir e-posta girin')
			.isLength({ max: 200 }).withMessage('E-posta en fazla 200 karakter olmalı')
			.normalizeEmail(),
		body('phone')
			.optional({ nullable: true })
			.customSanitizer(sanitizeTurkishPhoneToDigits)
			.custom((value) => {
				const v = String(value || '').trim();
				if (!v) return true;
				return /^\d+$/.test(v);
			}).withMessage('Telefon sadece sayısal olmalı')
			.custom((value) => {
				const v = String(value || '').trim();
				if (!v) return true;
				return v.length >= 10 && v.length <= 15;
			}).withMessage('Telefon formatı geçersiz'),
		body('subject')
			.optional({ nullable: true })
			.isString().withMessage('Konu geçersiz')
			.isLength({ max: 200 }).withMessage('Konu en fazla 200 karakter olmalı')
			.trim()
			.escape(),
		body('message')
			.notEmpty().withMessage('Mesaj boş olamaz')
			.isString().withMessage('Mesaj geçersiz')
			.isLength({ min: 10, max: 5000 }).withMessage('Mesaj 10-5000 karakter olmalı')
			.trim()
			.escape(),
	],
};

module.exports = {
	validateRequest,
	authValidation,
	adminValidation,
	bookingValidation,
	shopValidation,
};
