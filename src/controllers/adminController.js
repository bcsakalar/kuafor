const appointmentModel = require('../models/appointmentModel');
const serviceModel = require('../models/serviceModel');
const staffModel = require('../models/staffModel');
const businessHoursModel = require('../models/businessHoursModel');
const mediaModel = require('../models/mediaModel');
const settingsModel = require('../models/settingsModel');
const analyticsModel = require('../models/analyticsModel');
const adminModel = require('../models/adminModel');
const publicContactModel = require('../models/publicContactModel');

function isUuid(v) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

async function renderDashboard(req, res, next) {
	try {
		const [upcoming, todayAppointment, monthAppointment, staffOfMonth, last7DaysAppointmentRevenue, occupancy] = await Promise.all([
			appointmentModel.listUpcomingAppointments(50),
			analyticsModel.getTodayAppointmentRevenue(),
			analyticsModel.getThisMonthAppointmentRevenue(),
			analyticsModel.getStaffOfTheMonth(),
			analyticsModel.getLast7DaysAppointmentRevenueSeries(),
			analyticsModel.getTodayAppointmentOccupancy(),
		]);
		const upcomingMen = upcoming.filter((a) => a.category === 'men');
		const upcomingWomen = upcoming.filter((a) => a.category === 'women');
		res.render('admin/dashboard', {
			title: 'Yönetim Paneli',
			layout: 'layouts/admin',
			upcomingMen,
			upcomingWomen,
			todayAppointment,
			monthAppointment,
			staffOfMonth,
			last7DaysAppointmentRevenue,
			occupancy,
		});
	} catch (err) {
		next(err);
	}
}

function renderCalendar(req, res) {
	res.render('admin/calendar', { title: 'Takvim', layout: 'layouts/admin' });
}

async function renderSettings(req, res, next) {
	try {
		const services = (await serviceModel.listAllServices()).filter((s) => s.is_active !== false);
		const staff = (await staffModel.listAllStaff()).filter((p) => p.is_active !== false);
		const [hoursMen, hoursWomen, overridesMen, overridesWomen, contactMen, contactWomen, companySettings] = await Promise.all([
			businessHoursModel.getWeeklyHoursByCategory('men'),
			businessHoursModel.getWeeklyHoursByCategory('women'),
			businessHoursModel.listOverrides('men'),
			businessHoursModel.listOverrides('women'),
			settingsModel.getSettingJson('contact.men', null),
			settingsModel.getSettingJson('contact.women', null),
			settingsModel.getCompanySettings(),
		]);
		const servicesMen = services.filter((s) => s.category === 'men');
		const servicesWomen = services.filter((s) => s.category === 'women');
		const staffMen = staff.filter((p) => p.category === 'men');
		const staffWomen = staff.filter((p) => p.category === 'women');
		const staffBoth = staff.filter((p) => p.category === 'both');
		res.render('admin/settings', {
			title: 'Ayarlar',
			layout: 'layouts/admin',
			query: req.query,
			servicesMen,
			servicesWomen,
			staffMen,
			staffWomen,
			staffBoth,
			hoursMen,
			hoursWomen,
			overridesMen,
			overridesWomen,
			contactMen,
			contactWomen,
			companySettings,
		});
	} catch (err) {
		next(err);
	}
}

async function updateLegalSettings(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const redirectBase = base ? `${base}/ayarlar` : '/ayarlar';

		const payload = {
			company_name: req.body?.company_name,
			tax_office: req.body?.tax_office,
			tax_number: req.body?.tax_number,
			mersis_number: req.body?.mersis_number,
			kep_address: req.body?.kep_address,
			trade_registry_number: req.body?.trade_registry_number,
			contact_address: req.body?.contact_address,
			contact_phone: req.body?.contact_phone,
			contact_email: req.body?.contact_email,
			representative_name: req.body?.representative_name,
		};

		const mersis = String(payload.mersis_number || '').trim();
		const kep = String(payload.kep_address || '').trim();
		if (!mersis) {
			return res.status(400).redirect(`${redirectBase}?errLegal=${encodeURIComponent('MERSİS No zorunludur.')}`);
		}
		if (!kep) {
			return res.status(400).redirect(`${redirectBase}?errLegal=${encodeURIComponent('KEP adresi zorunludur.')}`);
		}

		await settingsModel.updateCompanySettings(payload);
		return res.redirect(`${redirectBase}?okLegal=1#legal`);
	} catch (err) {
		next(err);
	}
}

function renderGoogle(req, res) {
	res.render('admin/google', { title: 'Google Entegrasyonu', layout: 'layouts/admin', query: req.query });
}

async function renderAccount(req, res, next) {
	try {
		const adminId = req.session?.adminId;
		const admin = adminId ? await adminModel.findById(adminId) : null;
		res.render('admin/account', {
			title: 'Hesap Ayarları',
			layout: 'layouts/admin',
			admin,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function updateAccount(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const redirectBase = base ? `${base}/hesap` : '/hesap';

		const adminId = req.session?.adminId;
		if (!adminId) return res.redirect(base ? `${base}/login` : '/login');

		const currentPassword = String(req.body?.currentPassword || '');
		const newEmailRaw = String(req.body?.email || '').trim();
		const newPassword = String(req.body?.newPassword || '');
		const wantsEmailChange = Boolean(newEmailRaw);
		const wantsPasswordChange = Boolean(newPassword);

		if (!wantsEmailChange && !wantsPasswordChange) {
			return res.status(400).redirect(`${redirectBase}?err=${encodeURIComponent('E-posta veya yeni şifre girin.')}`);
		}

		const admin = await adminModel.findByIdWithPasswordHash(adminId);
		if (!admin) return res.status(400).redirect(`${redirectBase}?err=${encodeURIComponent('Admin bulunamadı.')}`);

		const ok = await adminModel.verifyPassword({ password: currentPassword, passwordHash: admin.password_hash });
		if (!ok) {
			return res.status(400).redirect(`${redirectBase}?err=${encodeURIComponent('Mevcut şifre hatalı.')}`);
		}

		const updates = {
			adminId,
			newEmail: wantsEmailChange ? newEmailRaw : null,
			newPassword: wantsPasswordChange ? newPassword : null,
		};

		await adminModel.updateCredentials(updates);

		// Security: credentials changed -> require re-login.
		try {
			req.session?.destroy(() => {
				res.clearCookie('connect.sid');
				res.redirect(base ? `${base}/login?ok=1` : '/login?ok=1');
			});
		} catch {
			return res.redirect(base ? `${base}/login?ok=1` : '/login?ok=1');
		}
		return;
	} catch (err) {
		// Unique violation (email)
		if (err && err.code === '23505') {
			const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
			const redirectBase = base ? `${base}/hesap` : '/hesap';
			return res.status(400).redirect(`${redirectBase}?err=${encodeURIComponent('Bu e-posta zaten kullanımda.')}`);
		}
		next(err);
	}
}

async function renderMedia(req, res, next) {
	try {
		const media = await mediaModel.getMedia();
		res.render('admin/media', {
			title: 'Medya',
			layout: 'layouts/admin',
			media,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function updateMediaSlot(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const key = (req.body.key || '').trim();
		const alt = (req.body.alt || '').trim();
		const src = req.file ? `/public/images/uploads/${req.file.filename}` : (req.body.src || '').trim();
		await mediaModel.upsertSlot({ slotKey: key, src, alt });
		res.redirect(base ? `${base}/medya?ok=1` : '/medya?ok=1');
	} catch (err) {
		next(err);
	}
}

async function addGalleryItem(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const alt = (req.body.alt || '').trim();
		const category = (req.body.category || '').trim();
		const src = req.file ? `/public/images/uploads/${req.file.filename}` : (req.body.src || '').trim();
		await mediaModel.addGalleryItem({ src, alt, category });
		res.redirect(base ? `${base}/medya?ok=1` : '/medya?ok=1');
	} catch (err) {
		next(err);
	}
}

async function updateGalleryItem(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const id = (req.params.id || '').trim();
		const alt = (req.body.alt || '').trim();
		const category = (req.body.category || '').trim();
		const src = req.file ? `/public/images/uploads/${req.file.filename}` : (req.body.src || '').trim();
		await mediaModel.updateGalleryItem({ id, src, alt, category });
		res.redirect(base ? `${base}/medya?ok=1` : '/medya?ok=1');
	} catch (err) {
		next(err);
	}
}

async function deleteGalleryItem(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const id = (req.params.id || '').trim();
		await mediaModel.deleteGalleryItem({ id });
		res.redirect(base ? `${base}/medya?ok=1` : '/medya?ok=1');
	} catch (err) {
		next(err);
	}
}

async function renderPublicContactInbox(req, res, next) {
	try {
		const status = String(req.query?.status || 'new').trim().toLowerCase();
		const limitRaw = req.query?.limit == null ? '' : String(req.query.limit).trim();
		const limit = Math.max(1, Math.min(200, Number(limitRaw) || 100));
		const messages = await publicContactModel.listMessages({ status, limit });
		res.render('admin/contactInbox', {
			title: 'İletişim Mesajları',
			layout: 'layouts/admin',
			messages,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function renderPublicContactMessageDetail(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : '';
		const messageId = String(req.params.id || '').trim();
		if (!isUuid(messageId)) return res.redirect(`${base}/inbox?err=notfound`);
		const message = await publicContactModel.getMessageById(messageId);
		if (!message) return res.redirect(`${base}/inbox?err=notfound`);

		if (String(message.status || '').trim().toLowerCase() === 'new') {
			try {
				await publicContactModel.setMessageStatus({ messageId, status: 'read' });
				message.status = 'read';
			} catch {
				// non-blocking
			}
		}

		res.render('admin/contactMessage', {
			title: 'Mesaj Detayı',
			layout: 'layouts/admin',
			message,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function updatePublicContactMessageStatus(req, res, next) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : '';
		const messageId = String(req.params.id || '').trim();
		const status = String(req.body?.status || 'read').trim().toLowerCase();
		const updated = await publicContactModel.setMessageStatus({ messageId, status });
		if (!updated) return res.redirect(`${base}/inbox?err=notfound`);

		const returnTo = String(req.body?.returnTo || '').trim().toLowerCase();
		if (returnTo === 'list') return res.redirect(`${base}/inbox?ok=1`);
		return res.redirect(`${base}/inbox/${encodeURIComponent(messageId)}?ok=1`);
	} catch (err) {
		next(err);
	}
}

module.exports = {
	renderDashboard,
	renderCalendar,
	renderSettings,
	updateLegalSettings,
	renderAccount,
	updateAccount,
	renderGoogle,
	renderMedia,
	updateMediaSlot,
	addGalleryItem,
	updateGalleryItem,
	deleteGalleryItem,
	renderPublicContactInbox,
	renderPublicContactMessageDetail,
	updatePublicContactMessageStatus,
};
