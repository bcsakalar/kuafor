const serviceModel = require('../models/serviceModel');
const staffModel = require('../models/staffModel');
const mediaModel = require('../models/mediaModel');
const businessHoursModel = require('../models/businessHoursModel');
const settingsModel = require('../models/settingsModel');
const publicContactModel = require('../models/publicContactModel');
const { normalizeMapsEmbedUrl } = require('../utils/maps');
const { logger } = require('../config/logger');
const { getTemplate, sendEmail } = require('../services/emailService');
const { getContactNotifyToEmail, getInfoEmail } = require('../config/email');

function getCurrentCategory(req) {
	const q = String(req.query.category || '').toLowerCase();
	return q === 'women' ? 'women' : 'men';
}

function getMapsEmbedUrl() {
	// Optional: set MAPS_EMBED_URL in .env for a real map iframe.
	return normalizeMapsEmbedUrl(process.env.MAPS_EMBED_URL ? String(process.env.MAPS_EMBED_URL) : '');
}

function normalizeContact(contact) {
	if (!contact || typeof contact !== 'object') return contact;
	return {
		...contact,
		mapsEmbedUrl: normalizeMapsEmbedUrl(contact.mapsEmbedUrl || ''),
	};
}

function getPageNumber(req) {
	const raw = String(req.query.page || '').trim();
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : 1;
}

async function getFooterHours() {
	const [hoursMen, hoursWomen] = await Promise.all([
		businessHoursModel.getWeeklyHoursByCategory('men'),
		businessHoursModel.getWeeklyHoursByCategory('women'),
	]);
	return { hoursMen, hoursWomen };
}

async function renderHome(req, res, next) {
	try {
		const currentCategory = getCurrentCategory(req);
		const media = await mediaModel.getMedia();
		const [menServices, womenServices, menStaff, womenStaff, contactMen, contactWomen, footer] = await Promise.all([
			serviceModel.listServicesByCategory('men'),
			serviceModel.listServicesByCategory('women'),
			staffModel.listStaffByCategory('men'),
			staffModel.listStaffByCategory('women'),
			settingsModel.getSettingJson('contact.men', null),
			settingsModel.getSettingJson('contact.women', null),
			getFooterHours(),
		]);
		res.render('pages/home', {
			title: 'Ana Sayfa',
			currentCategory,
			media,
			menServices,
			womenServices,
			menStaff,
			womenStaff,
			contactMen: normalizeContact(contactMen),
			contactWomen: normalizeContact(contactWomen),
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
			mapsEmbedUrl: getMapsEmbedUrl(),
		});
	} catch (err) {
		next(err);
	}
}

async function renderAbout(req, res, next) {
	try {
		const media = await mediaModel.getMedia();
		const footer = await getFooterHours();
		res.render('pages/about', {
			title: 'Hakkımızda',
			currentCategory: getCurrentCategory(req),
			media,
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

async function renderServices(req, res, next) {
	try {
		const currentCategory = getCurrentCategory(req);
		const media = await mediaModel.getMedia();
		const [menServices, womenServices, footer] = await Promise.all([
			serviceModel.listServicesByCategory('men'),
			serviceModel.listServicesByCategory('women'),
			getFooterHours(),
		]);
		res.render('pages/services', {
			title: 'Hizmetler',
			currentCategory,
			media,
			menServices,
			womenServices,
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

async function renderGallery(req, res, next) {
	try {
		const currentCategory = getCurrentCategory(req);
		const pageSize = 12;
		const page = getPageNumber(req);

		const [media, footer] = await Promise.all([
			mediaModel.getMedia(),
			getFooterHours(),
		]);
		const all = Array.isArray(media?.gallery) ? media.gallery : [];
		const newestFirst = all.slice().reverse();
		const filtered = newestFirst.filter((it) => {
			const c = it?.category ? String(it.category) : 'both';
			if (currentCategory === 'women') return c === 'women' || c === 'both';
			return c === 'men' || c === 'both';
		});

		const totalItems = filtered.length;
		const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
		const safePage = Math.min(totalPages, Math.max(1, page));
		const start = (safePage - 1) * pageSize;
		const galleryItems = filtered.slice(start, start + pageSize);

		res.render('pages/gallery', {
			title: 'Galeri',
			currentCategory,
			media,
			galleryItems,
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
			pagination: {
				page: safePage,
				pageSize,
				totalItems,
				totalPages,
			},
		});
	} catch (err) {
		next(err);
	}
}

async function renderContact(req, res, next) {
	try {
		const sent = String(req.query.sent || '').trim() === '1';
		const hasError = String(req.query.err || '').trim() === '1';
		const media = await mediaModel.getMedia();
		const [contactMen, contactWomen, hoursMen, hoursWomen] = await Promise.all([
			settingsModel.getSettingJson('contact.men', null),
			settingsModel.getSettingJson('contact.women', null),
			businessHoursModel.getWeeklyHoursByCategory('men'),
			businessHoursModel.getWeeklyHoursByCategory('women'),
		]);
		res.render('pages/contact', {
			title: 'İletişim',
			currentCategory: getCurrentCategory(req),
			mapsEmbedUrl: getMapsEmbedUrl(),
			contactMen: normalizeContact(contactMen),
			contactWomen: normalizeContact(contactWomen),
			hoursMen,
			hoursWomen,
			media,
			sent,
			hasError,
		});
	} catch (err) {
		next(err);
	}
}

async function contactPost(req, res, next) {
	try {
		const name = String(req.body?.name || '').trim();
		const email = String(req.body?.email || '').trim();
		const subject = String(req.body?.subject || '').trim();
		const message = String(req.body?.message || '').trim();

		const createdIp = (() => {
			const forwarded = String(req.headers['x-forwarded-for'] || '').trim();
			if (forwarded) return forwarded.split(',')[0].trim();
			return String(req.ip || '').trim();
		})();
		const userAgent = String(req.headers['user-agent'] || '').trim();

		const adminEmail = String(getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
		const contactEmail = String(getInfoEmail() || adminEmail || '').trim();

		// Minimal validation
		if (!name || name.length < 2 || name.length > 120) return res.redirect('/iletisim?err=1');
		if (!email || email.length > 200 || !email.includes('@')) return res.redirect('/iletisim?err=1');
		if (!subject || subject.length < 2 || subject.length > 200) return res.redirect('/iletisim?err=1');
		if (!message || message.length < 5 || message.length > 4000) return res.redirect('/iletisim?err=1');

		// Persist message for Admin inbox (best-effort; do not block email delivery).
		try {
			await publicContactModel.createMessage({
				fullName: name,
				email,
				subject,
				message,
				createdIp: createdIp || null,
				userAgent: userAgent || null,
			});
		} catch (err) {
			logger.error('[contact] db insert failed', {
				message: err?.message,
				code: err?.code,
				email,
				subject,
				stack: err?.stack,
			});
		}
		if (!adminEmail) {
			logger.error('[contact] ADMIN_EMAIL missing; cannot deliver contact form', {
				name,
				email,
				subject,
			});
			return res.redirect('/iletisim?err=1');
		}

		const adminSubject = `İletişim Formu: ${subject}`;
		const userSubject = 'Mesajınız alındı, size döneceğiz';

		const [adminHtml, userHtml] = await Promise.all([
			getTemplate('contact-form', { variant: 'admin', name, email, subject, message }),
			getTemplate('contact-form', { variant: 'user', name, email, subject, message }),
		]);

		let okAdmin = false;
		let okUser = false;

		try {
			await sendEmail(adminEmail, adminSubject, adminHtml, {
				channel: 'booking',
				replyTo: email || undefined,
			});
			okAdmin = true;
		} catch (err) {
			logger.error('[contact] admin email failed', {
				message: err?.message,
				code: err?.code,
				adminEmail,
				fromEmail: email,
				stack: err?.stack,
			});
		}

		try {
			await sendEmail(email, userSubject, userHtml, {
				channel: 'booking',
				// Use info@ as the visible sender (Brevo verified sender), and keep replies routed to info@.
				fromEmail: contactEmail || undefined,
				replyTo: contactEmail || undefined,
			});
			okUser = true;
		} catch (err) {
			logger.error('[contact] user auto-reply email failed', {
				message: err?.message,
				code: err?.code,
				userEmail: email,
				stack: err?.stack,
			});
		}

		if (okAdmin && okUser) return res.redirect('/iletisim?sent=1');
		return res.redirect('/iletisim?err=1');
	} catch (err) {
		logger.error('[contact] contactPost failed', {
			message: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
		return res.redirect('/iletisim?err=1');
	}
}

async function renderStaff(req, res, next) {
	try {
		const currentCategory = getCurrentCategory(req);
		const media = await mediaModel.getMedia();
		const [menStaff, womenStaff, footer] = await Promise.all([
			staffModel.listStaffByCategory('men'),
			staffModel.listStaffByCategory('women'),
			getFooterHours(),
		]);
		res.render('pages/staff', {
			title: 'Ekibimiz',
			currentCategory,
			media,
			menStaff,
			womenStaff,
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

async function renderBookingChoose(req, res, next) {
	try {
		const media = await mediaModel.getMedia();
		const footer = await getFooterHours();
		res.render('booking/choose', {
			title: 'Randevu Al',
			currentCategory: getCurrentCategory(req),
			media,
			hoursMen: footer.hoursMen,
			hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

async function renderBookingMen(req, res, next) {
	try {
		const media = await mediaModel.getMedia();
		const footer = await getFooterHours();
		res.render('booking/index', {
		title: 'Berber (Erkek) Randevu',
		currentCategory: 'men',
		presetCategory: 'men',
		apiBase: '/berber/booking',
		shopTitle: 'Berber (Erkek) Şubesi',
		media,
		hoursMen: footer.hoursMen,
		hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

async function renderBookingWomen(req, res, next) {
	try {
		const media = await mediaModel.getMedia();
		const footer = await getFooterHours();
		res.render('booking/index', {
		title: 'Güzellik (Kadın) Randevu',
		currentCategory: 'women',
		presetCategory: 'women',
		apiBase: '/guzellik/booking',
		shopTitle: 'Güzellik (Kadın) Şubesi',
		media,
		hoursMen: footer.hoursMen,
		hoursWomen: footer.hoursWomen,
		});
	} catch (err) {
		next(err);
	}
}

module.exports = {
	renderHome,
	renderAbout,
	renderServices,
	renderStaff,
	renderGallery,
	renderContact,
	contactPost,
	renderBookingChoose,
	renderBookingMen,
	renderBookingWomen,
};
