const { body, query, param, validationResult } = require('express-validator');
const { pool } = require('../config/db');
const appointmentModel = require('../models/appointmentModel');
const businessHoursModel = require('../models/businessHoursModel');
const staffModel = require('../models/staffModel');
const settingsModel = require('../models/settingsModel');
const googleCalendar = require('../services/googleCalendar');
const socketService = require('../services/socketService');
const { normalizeMapsEmbedUrl } = require('../utils/maps');
const { DateTime } = require('luxon');
const { logger } = require('../config/logger');
const { sendEmail, getTemplate } = require('../services/emailService');
const { getContactNotifyToEmail, getInfoEmail } = require('../config/email');

function validate(req) {
	const result = validationResult(req);
	if (!result.isEmpty()) {
		const error = new Error('Validation failed');
		error.statusCode = 400;
		error.details = result.array();
		throw error;
	}
}

const validateUpsertService = [
	body('id').optional({ nullable: true }).isUUID(),
	body('name').isString().isLength({ min: 2, max: 80 }),
	body('durationMinutes').isInt({ min: 10, max: 600 }),
	body('priceCents').isInt({ min: 0, max: 10_000_000 }),
	body('category').isIn(['men', 'women']),
	body('isActive').optional().isBoolean(),
];

const validateDeleteService = [
	param('id').isUUID().withMessage('Invalid service id'),
];

async function upsertService(req, res, next) {
	try {
		validate(req);
		const { id, name, durationMinutes, priceCents, category, isActive } = req.body;

		if (id) {
			await pool.query(
				`UPDATE services
				 SET name=$2, duration_minutes=$3, price_cents=$4, category=$5, is_active=COALESCE($6, is_active), updated_at=now()
				 WHERE id=$1`,
				[id, name, durationMinutes, priceCents, category, isActive]
			);
			return res.json({ ok: true });
		}

		await pool.query(
			`INSERT INTO services (name, duration_minutes, price_cents, category, is_active)
			 VALUES ($1,$2,$3,$4, COALESCE($5,true))`,
			[name, durationMinutes, priceCents, category, isActive]
		);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

async function deleteService(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		await pool.query('BEGIN');
		// services -> appointment_services has ON DELETE RESTRICT
		// If you truly want to remove a service, first remove its join rows.
		await pool.query(
			`DELETE FROM appointment_services
			 WHERE service_id = $1`,
			[id]
		);
		await pool.query(
			`DELETE FROM services
			 WHERE id = $1`,
			[id]
		);
		await pool.query('COMMIT');
		res.json({ ok: true });
	} catch (err) {
		try { await pool.query('ROLLBACK'); } catch { /* noop */ }
		next(err);
	}
}

const validateCreateStaff = [
	body('fullName').isString().isLength({ min: 2, max: 80 }),
	body('category').isIn(['men', 'women', 'both']),
	body('googleCalendarId').optional({ nullable: true }).isString().isLength({ max: 200 }),
	body('isActive').optional().isBoolean(),
];

const validateUpdateStaff = [
	param('id').isUUID().withMessage('Invalid staff id'),
	body('fullName').isString().isLength({ min: 2, max: 80 }),
	body('category').isIn(['men', 'women', 'both']),
	body('googleCalendarId').optional({ nullable: true }).isString().isLength({ max: 200 }),
	body('isActive').optional().isBoolean(),
];

const validateDeleteStaff = [
	param('id').isUUID().withMessage('Invalid staff id'),
];

async function createStaff(req, res, next) {
	try {
		validate(req);
		const { fullName, category, googleCalendarId, isActive } = req.body;
		await pool.query(
			`INSERT INTO staff (full_name, category, google_calendar_id, is_active)
			 VALUES ($1,$2,$3, COALESCE($4,true))`,
			[fullName, category, googleCalendarId || null, isActive]
		);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

async function updateStaff(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		const { fullName, category, googleCalendarId, isActive } = req.body;
		await pool.query(
			`UPDATE staff
			 SET full_name=$2,
				 category=$3,
				 google_calendar_id=$4,
				 is_active=COALESCE($5, is_active),
				 updated_at=now()
			 WHERE id=$1`,
			[id, fullName, category, googleCalendarId || null, isActive]
		);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

async function deleteStaff(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		// appointments.staff_id has ON DELETE SET NULL, so hard delete is safe.
		await pool.query(
			`DELETE FROM staff
			 WHERE id = $1`,
			[id]
		);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

const validateListAppointments = [
	body('start').optional().isISO8601().withMessage('Invalid start'),
	body('end').optional().isISO8601().withMessage('Invalid end'),
];

async function listAppointments(req, res, next) {
	try {
		// Query params are simpler for GET; keep validation inline.
		const { start, end, category, staffId, includePast } = req.query;
		if (!start || !end) {
			return res.status(400).json({ message: 'start and end are required' });
		}
		if (category && !['men', 'women'].includes(category)) {
			return res.status(400).json({ message: 'Invalid category' });
		}
		if (staffId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(staffId))) {
			return res.status(400).json({ message: 'Invalid staffId' });
		}
		const includePastBool = String(includePast || '') === '1' || String(includePast || '').toLowerCase() === 'true';

		const appointments = await appointmentModel.listAppointmentsInRange({
			start,
			end,
			category: category || null,
			staffId: staffId ? String(staffId) : null,
			includePast: includePastBool,
		});

		res.json({ appointments });
	} catch (err) {
		next(err);
	}
}

const validateListStaff = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
];

async function listStaff(req, res, next) {
	try {
		validate(req);
		const { category } = req.query;
		const staff = await staffModel.listStaffByCategory(category);
		res.json({ staff });
	} catch (err) {
		next(err);
	}
}

function toDate(v) {
	const d = new Date(v);
	return Number.isFinite(d.getTime()) ? d : null;
}

const validateUpdateAppointment = [
	param('id').isUUID().withMessage('Invalid appointment id'),
	body('startsAt').isISO8601().withMessage('Invalid startsAt'),
	body('endsAt').isISO8601().withMessage('Invalid endsAt'),
	body('staffId').optional({ nullable: true }).isUUID().withMessage('Invalid staffId'),
	body('customerFullName').isString().isLength({ min: 2, max: 120 }),
	body('customerPhone').isString().isLength({ min: 3, max: 40 }),
	body('customerEmail').optional({ nullable: true }).isEmail().withMessage('Invalid customerEmail'),
	body('notes').optional({ nullable: true }).isString().isLength({ max: 1000 }),
];

async function updateAppointment(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		const {
			staffId,
			startsAt,
			endsAt,
			customerFullName,
			customerPhone,
			customerEmail,
			notes,
		} = req.body;

		const before = await appointmentModel.getAppointmentById(id);
		if (!before) return res.status(404).json({ message: 'Randevu bulunamadı.' });
		if (before.status !== 'booked') return res.status(409).json({ message: 'Bu randevu artık aktif değil.' });

		const starts = toDate(startsAt);
		const ends = toDate(endsAt);
		if (!starts || !ends || ends <= starts) return res.status(400).json({ message: 'Geçersiz saat aralığı.' });

		let updated;
		try {
			updated = await appointmentModel.updateAppointment({
				appointmentId: id,
				staffId: staffId || null,
				startsAt: starts.toISOString(),
				endsAt: ends.toISOString(),
				customerFullName,
				customerPhone,
				customerEmail: customerEmail || null,
				notes: notes || null,
			});
		} catch (err) {
			// Exclusion constraint conflict
			if (err?.code === '23P01') {
				return res.status(409).json({ message: 'Bu saat aralığında seçili personelde çakışma var.' });
			}
			throw err;
		}

		if (!updated) return res.status(404).json({ message: 'Randevu güncellenemedi.' });

		// Real-time notify (best-effort)
		try {
			const appointment = await appointmentModel.getAppointmentById(updated.id);
			if (appointment) {
				const tz = 'Europe/Istanbul';
				const startsLocal = DateTime
					.fromJSDate(new Date(appointment.starts_at), { zone: 'utc' })
					.setZone(tz)
					.setLocale('tr');
				const date = startsLocal.toFormat('dd LLLL yyyy');
				const time = startsLocal.toFormat('HH:mm');
				const services = Array.isArray(appointment.services)
					? appointment.services.map((s) => s?.name).filter(Boolean)
					: [];

				socketService.getIO().to('adminRoom').emit('updateAppointment', {
					appointmentId: appointment.id,
					category: appointment.category,
					status: appointment.status,
					startsAt: appointment.starts_at,
					endsAt: appointment.ends_at,
					date,
					time,
					customerName: appointment.customer_full_name || '',
					service: services.join(', '),
				});
			}
		} catch (err) {
			logger.warn('[socket] updateAppointment emit failed (continuing)', {
				message: err?.message,
				code: err?.code,
				appointmentId: id,
			});
		}

		// Best-effort Google sync
		const staffIds = [before.staff_id, updated.staff_id].filter(Boolean);
		const summary = `${updated.category === 'men' ? 'Berber' : 'Güzellik'} Randevu`;
		const description = `Müşteri: ${customerFullName}\nTelefon: ${customerPhone}${customerEmail ? `\nE-posta: ${customerEmail}` : ''}${notes ? `\nNot: ${notes}` : ''}\nKod: ${updated.id}`;
		if (updated.google_event_id) {
			await googleCalendar.updateEventForAppointment({
				eventId: updated.google_event_id,
				staffIds,
				startsAt: starts,
				endsAt: ends,
				summary,
				description,
			});
		} else if (updated.staff_id) {
			const newEventId = await googleCalendar.createEventForAppointment({
				staffId: updated.staff_id,
				startsAt: starts,
				endsAt: ends,
				summary,
				description,
			});
			if (newEventId) await appointmentModel.setGoogleEventId({ appointmentId: updated.id, googleEventId: newEventId });
		}

		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

const validateCancelAppointment = [
	param('id').isUUID().withMessage('Invalid appointment id'),
	body('reason').optional({ nullable: true }).isString().isLength({ max: 280 }).withMessage('Invalid reason'),
];

async function cancelAppointment(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		const reason = String(req.body?.reason || '').trim() || null;
		const before = await appointmentModel.getAppointmentById(id);
		if (!before) return res.status(404).json({ message: 'Randevu bulunamadı.' });
		if (before.status !== 'booked') return res.status(409).json({ message: 'Bu randevu artık aktif değil.' });

		const cancelled = await appointmentModel.cancelAppointment({ appointmentId: id, cancelReason: reason });
		if (!cancelled) return res.status(404).json({ message: 'Randevu iptal edilemedi.' });

		// Real-time notify (best-effort)
		try {
			const tz = 'Europe/Istanbul';
			const startsLocal = DateTime
				.fromJSDate(new Date(before.starts_at), { zone: 'utc' })
				.setZone(tz)
				.setLocale('tr');
			const date = startsLocal.toFormat('dd LLLL yyyy');
			const time = startsLocal.toFormat('HH:mm');
			const services = Array.isArray(before.services)
				? before.services.map((s) => s?.name).filter(Boolean)
				: [];

			socketService.getIO().to('adminRoom').emit('updateAppointment', {
				appointmentId: before.id,
				category: before.category,
				status: 'cancelled',
				startsAt: before.starts_at,
				endsAt: before.ends_at,
				date,
				time,
				customerName: before.customer_full_name || '',
				service: services.join(', '),
			});
		} catch (err) {
			logger.warn('[socket] updateAppointment emit failed (continuing)', {
				message: err?.message,
				code: err?.code,
				appointmentId: id,
			});
		}

		if (before.google_event_id) {
			await googleCalendar.deleteEventForAppointment({
				eventId: before.google_event_id,
				staffIds: [before.staff_id].filter(Boolean),
			});
		}

		// Fire-and-forget: cancellation email notifications
		try {
			const businessEmail = String(getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
			const contactEmail = String(getInfoEmail() || businessEmail || '').trim();
			const contactPhone = String(process.env.BOOKING_CONTACT_PHONE || '').trim();
			const beforeCopy = before;
			void (async () => {
				const tz = 'Europe/Istanbul';
				const startsLocal = DateTime
					.fromJSDate(new Date(beforeCopy.starts_at), { zone: 'utc' })
					.setZone(tz)
					.setLocale('tr');
				const dateText = startsLocal.toFormat('dd LLLL yyyy');
				const timeText = startsLocal.toFormat('HH:mm');

				const services = Array.isArray(beforeCopy.services) ? beforeCopy.services : [];
				const staffName = String(beforeCopy.staff_full_name || '').trim();
				const customerName = String(beforeCopy.customer_full_name || '').trim();
				const customerPhone = String(beforeCopy.customer_phone || '').trim();
				const customerEmail = String(beforeCopy.customer_email || '').trim();
				const notes = String(beforeCopy.notes || '').trim();
				const cancelReason = reason;

				if (customerEmail) {
					const html = await getTemplate('booking/booking-cancelled', {
						variant: 'customer',
						appointmentId: id,
						dateText,
						timeText,
						services,
						staffName,
						customerName,
						cancelReason,
						contactEmail,
						contactPhone,
					});
					await sendEmail(customerEmail, 'Randevu İptali', html, {
						channel: 'booking',
						replyTo: contactEmail || undefined,
					});
				}
			})().catch((err) => {
				logger.error('[booking] cancellation email notifications failed', {
					message: err?.message,
					code: err?.code,
					appointmentId: id,
					stack: err?.stack,
				});
			});
		} catch (err) {
			logger.error('[booking] failed to schedule cancellation emails', {
				message: err?.message,
				code: err?.code,
				appointmentId: id,
				stack: err?.stack,
			});
		}

		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

const validateGetAppointmentById = [
	param('id').isUUID().withMessage('Invalid appointment id'),
];

async function getAppointmentById(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		const appointment = await appointmentModel.getAppointmentById(id);
		if (!appointment) {
			return res.status(404).json({ message: 'Randevu bulunamadı.' });
		}
		res.json({ appointment });
	} catch (err) {
		next(err);
	}
}

async function googleStatus(req, res, next) {
	try {
		const hasRedirect = Boolean(
			(process.env.GOOGLE_REDIRECT_URI && String(process.env.GOOGLE_REDIRECT_URI).trim()) ||
			(process.env.GOOGLE_REDIRECT_URIS && String(process.env.GOOGLE_REDIRECT_URIS).trim())
		);
		const envConfigured = Boolean(
			process.env.GOOGLE_CLIENT_ID &&
			process.env.GOOGLE_CLIENT_SECRET &&
			hasRedirect
		);

		const { rows } = await pool.query(
			`SELECT
				id,
				client_id,
				redirect_uri,
				(access_token IS NOT NULL OR refresh_token IS NOT NULL) AS has_tokens,
				expiry_date,
				updated_at
			FROM google_oauth_tokens
			ORDER BY updated_at DESC
			LIMIT 1`
		);

		const row = rows[0] || null;
		const dbConfigured = Boolean(row?.client_id && row?.redirect_uri);
		const configured = envConfigured || dbConfigured;
		const connected = Boolean(row?.has_tokens);

		res.json({
			configured,
			connected,
			expiryDate: row?.expiry_date || null,
			updatedAt: row?.updated_at || null,
		});
	} catch (err) {
		next(err);
	}
}

async function googleDisconnect(req, res, next) {
	try {
		// Clear stored tokens (env config stays in .env).
		await pool.query(
			`UPDATE google_oauth_tokens
			SET access_token = NULL,
				refresh_token = NULL,
				scope = NULL,
				token_type = NULL,
				expiry_date = NULL,
				updated_at = now()`
		);

		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

function isTimeStr(v) {
	return /^\d{2}:\d{2}(:\d{2})?$/.test(String(v || ''));
}

const validateGetHours = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
];

async function getHours(req, res, next) {
	try {
		validate(req);
		const { category } = req.query;
		const hours = await businessHoursModel.getWeeklyHoursByCategory(category);
		res.json({ hours });
	} catch (err) {
		next(err);
	}
}

const validateUpsertHours = [
	body('category').isIn(['men', 'women']),
	body('days').isArray({ min: 1, max: 7 }),
	body('days.*.dayOfWeek').isInt({ min: 0, max: 6 }),
	body('days.*.isClosed').optional().isBoolean(),
	body('days.*.startTime').custom((v) => isTimeStr(v)).withMessage('Invalid startTime'),
	body('days.*.endTime').custom((v) => isTimeStr(v)).withMessage('Invalid endTime'),
];

async function upsertHours(req, res, next) {
	try {
		validate(req);
		const { category, days } = req.body;
		await businessHoursModel.upsertWeeklyHours(category, days);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

const validateListOverrides = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
	query('from').optional().isISO8601().withMessage('Invalid from'),
	query('to').optional().isISO8601().withMessage('Invalid to'),
];

async function listOverrides(req, res, next) {
	try {
		validate(req);
		const { category, from, to } = req.query;
		const overrides = await businessHoursModel.listOverrides(category, from || null, to || null);
		res.json({ overrides });
	} catch (err) {
		next(err);
	}
}

const validateUpsertOverride = [
	body('category').isIn(['men', 'women']),
	body('date').isISO8601().withMessage('Invalid date'),
	body('isClosed').optional().isBoolean(),
	body('startTime').custom((v) => isTimeStr(v)).withMessage('Invalid startTime'),
	body('endTime').custom((v) => isTimeStr(v)).withMessage('Invalid endTime'),
	body('note').optional({ nullable: true }).isString().isLength({ max: 200 }),
];

async function upsertOverride(req, res, next) {
	try {
		validate(req);
		const { category, date, isClosed, startTime, endTime, note } = req.body;
		const dateKey = String(date).slice(0, 10);
		const id = await businessHoursModel.upsertOverride({
			category,
			date: dateKey,
			isClosed: Boolean(isClosed),
			startTime,
			endTime,
			note: note || null,
		});
		res.json({ ok: true, id });
	} catch (err) {
		next(err);
	}
}

const validateDeleteOverride = [
	param('id').isUUID().withMessage('Invalid id'),
];

async function deleteOverride(req, res, next) {
	try {
		validate(req);
		const { id } = req.params;
		await businessHoursModel.deleteOverride(id);
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

const validateGetContact = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
];

async function getContact(req, res, next) {
	try {
		validate(req);
		const { category } = req.query;
		const key = `contact.${category}`;
		const value = await settingsModel.getSettingJson(key, null);
		res.json({ contact: value });
	} catch (err) {
		next(err);
	}
}

const validateUpsertContact = [
	body('category').isIn(['men', 'women']),
	body('contact').isObject(),
	body('contact.title').optional({ nullable: true }).isString().isLength({ max: 120 }),
	body('contact.address').optional({ nullable: true }).isString().isLength({ max: 300 }),
	body('contact.phone').optional({ nullable: true }).isString().isLength({ max: 60 }),
	body('contact.email').optional({ nullable: true }).isString().isLength({ max: 120 }),
	body('contact.whatsapp').optional({ nullable: true }).isString().isLength({ max: 60 }),
	body('contact.mapsEmbedUrl').optional({ nullable: true }).isString().isLength({ max: 1000 }),
];

async function upsertContact(req, res, next) {
	try {
		validate(req);
		const { category, contact } = req.body;
		const key = `contact.${category}`;
		await settingsModel.setSettingJson(key, {
			title: contact.title || null,
			address: contact.address || null,
			phone: contact.phone || null,
			email: contact.email || null,
			whatsapp: contact.whatsapp || null,
			mapsEmbedUrl: normalizeMapsEmbedUrl(contact.mapsEmbedUrl || '') || null,
		});
		res.json({ ok: true });
	} catch (err) {
		next(err);
	}
}

module.exports = {
	validateUpsertService,
	validateDeleteService,
	validateCreateStaff,
	validateUpdateStaff,
	validateDeleteStaff,
	upsertService,
	deleteService,
	createStaff,
	updateStaff,
	deleteStaff,
	validateListStaff,
	listStaff,
	validateListAppointments,
	listAppointments,
	validateGetAppointmentById,
	getAppointmentById,
	validateUpdateAppointment,
	updateAppointment,
	validateCancelAppointment,
	cancelAppointment,
	validateGetHours,
	getHours,
	validateUpsertHours,
	upsertHours,
	validateListOverrides,
	listOverrides,
	validateUpsertOverride,
	upsertOverride,
	validateDeleteOverride,
	deleteOverride,
	validateGetContact,
	getContact,
	validateUpsertContact,
	upsertContact,
	googleStatus,
	googleDisconnect,
};
