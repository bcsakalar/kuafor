const { query, validationResult } = require('express-validator');

const serviceModel = require('../models/serviceModel');
const staffModel = require('../models/staffModel');
const appointmentModel = require('../models/appointmentModel');
const businessHoursModel = require('../models/businessHoursModel');
const googleCalendar = require('../services/googleCalendar');
const socketService = require('../services/socketService');
const { DateTime } = require('luxon');
const { logger, businessLogger } = require('../config/logger');
const { sendEmail, getTemplate } = require('../services/emailService');
const { getBookingNotifyToEmail, getContactNotifyToEmail, getInfoEmail } = require('../config/email');
const { cacheService, CACHE_KEYS, CACHE_TTL } = require('../services/cacheService');

const APPOINTMENT_DURATION_MINUTES = 40;

function validate(req) {
	const result = validationResult(req);
	if (!result.isEmpty()) {
		const error = new Error('Validation failed');
		error.statusCode = 400;
		error.details = result.array();
		throw error;
	}
}

const validateCategory = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
];

async function apiListServices(req, res, next) {
	try {
		validate(req);
		const { category } = req.query;
		
		// Use cache for services (reduces DB load)
		const cacheKey = CACHE_KEYS.SERVICES(category);
		const services = await cacheService.getOrSet(
			cacheKey,
			() => serviceModel.listServicesByCategory(category),
			CACHE_TTL.SERVICES
		);
		
		res.json({ services });
	} catch (err) {
		next(err);
	}
}

async function apiListStaff(req, res, next) {
	try {
		validate(req);
		const { category } = req.query;
		
		// Use cache for staff list (reduces DB load)
		const cacheKey = CACHE_KEYS.STAFF(category);
		const staff = await cacheService.getOrSet(
			cacheKey,
			() => staffModel.listStaffByCategory(category),
			CACHE_TTL.STAFF
		);
		
		res.json({ staff });
	} catch (err) {
		next(err);
	}
}

const validateAvailability = [
	query('category').isIn(['men', 'women']).withMessage('Invalid category'),
	query('staffId').optional().isUUID().withMessage('Invalid staffId'),
	query('date').isISO8601().withMessage('Invalid date'),
];

async function apiCheckAvailability(req, res, next) {
	try {
		validate(req);
		const { category, staffId, date } = req.query;
		const staffList = staffId ? [] : await staffModel.listStaffByCategory(category);

		// Working hours are dynamic: weekly schedule + date overrides (holiday/half-day).
		const dateKey = String(date).slice(0, 10); // YYYY-MM-DD
		const effective = await businessHoursModel.getEffectiveHours({ category, dateStr: dateKey });
		if (!effective || effective.isClosed) {
			return res.json({
				slots: [],
				closed: Boolean(!effective || effective.isClosed),
				message: !effective ? 'Bu tarih için çalışma saatleri tanımlı değil.' : 'Seçilen gün kapalı.',
				source: effective ? effective.source : null,
			});
		}

		// IMPORTANT: Calculate working-hour slots in Europe/Istanbul to avoid timezone drift.
		// The API returns UTC ISO instants; the browser renders them in local time.
		const tz = 'Europe/Istanbul';
		const [y, m, d] = dateKey.split('-').map((x) => Number(x));
		const { hours: startH, minutes: startM } = businessHoursModel.parseTimeToParts(effective.startTime);
		const { hours: endH, minutes: endM } = businessHoursModel.parseTimeToParts(effective.endTime);

		const startOfDay = DateTime.fromObject({ year: y, month: m, day: d, hour: startH, minute: startM, second: 0 }, { zone: tz });
		const endOfDay = DateTime.fromObject({ year: y, month: m, day: d, hour: endH, minute: endM, second: 0 }, { zone: tz });
		if (!(startOfDay.toMillis() < endOfDay.toMillis())) {
			return res.json({ slots: [], closed: false, message: 'Bu tarih için çalışma saatleri geçersiz.' });
		}

		const durationMs = APPOINTMENT_DURATION_MINUTES * 60_000;
		const slots = [];

		for (let cursor = startOfDay.toMillis(); cursor + durationMs <= endOfDay.toMillis(); cursor += durationMs) {
			const startsAtLocal = DateTime.fromMillis(cursor, { zone: tz });
			const endsAtLocal = DateTime.fromMillis(cursor + durationMs, { zone: tz });
			const startsAtUtcIso = startsAtLocal.toUTC().toISO();
			const endsAtUtcIso = endsAtLocal.toUTC().toISO();
			const startsAtDate = startsAtLocal.toJSDate();
			const endsAtDate = endsAtLocal.toJSDate();

			let isBusy = false;

			if (staffId) {
				const overlap = await appointmentModel.findOverlappingAppointments({
					staffId,
					startsAt: startsAtUtcIso,
					endsAt: endsAtUtcIso,
				});
				if (overlap) isBusy = true;

				if (!isBusy) {
					const googleBusy = await googleCalendar.isStaffBusy({ staffId, startsAt: startsAtDate, endsAt: endsAtDate });
					if (googleBusy) isBusy = true;
				}
			} else {
				// Auto-assign scenario: slot is available if ANY staff is free.
				let anyFree = false;
				for (const p of staffList) {
					const overlap = await appointmentModel.findOverlappingAppointments({
						staffId: p.id,
						startsAt: startsAtUtcIso,
						endsAt: endsAtUtcIso,
					});
					if (overlap) continue;
					const googleBusy = await googleCalendar.isStaffBusy({ staffId: p.id, startsAt: startsAtDate, endsAt: endsAtDate });
					if (googleBusy) continue;
					anyFree = true;
					break;
				}
				isBusy = !anyFree;
			}

			slots.push({
				startsAt: startsAtUtcIso,
				endsAt: endsAtUtcIso,
				available: !isBusy,
			});
		}

		res.json({ slots });
	} catch (err) {
		next(err);
	}
}

async function apiCreateBooking(req, res, next) {
	try {
		const {
			category,
			serviceIds,
			staffId,
			startsAt,
			customerFullName,
			customerPhone,
			customerEmail,
			notes,
		} = req.body;

		const computedEndsAt = DateTime.fromISO(startsAt, { zone: 'utc' })
			.plus({ minutes: APPOINTMENT_DURATION_MINUTES })
			.toUTC()
			.toISO();

		if (staffId) {
			const overlap = await appointmentModel.findOverlappingAppointments({ staffId, startsAt, endsAt: computedEndsAt });
			if (overlap) {
				return res.status(409).json({ message: 'Seçilen personel bu saatte dolu. Lütfen başka bir saat seçin.' });
			}
			const googleBusy = await googleCalendar.isStaffBusy({
				staffId,
				startsAt: new Date(startsAt),
				endsAt: new Date(computedEndsAt),
			});
			if (googleBusy) {
				return res.status(409).json({ message: 'Seçilen personel bu saatte dolu. Lütfen başka bir saat seçin.' });
			}
		}

		const candidateStaffIds = await (async () => {
			if (staffId) return [staffId];
			const staffList = await staffModel.listStaffByCategory(category);
			return staffList.map((p) => p.id);
		})();

		if (!candidateStaffIds.length) {
			return res.status(409).json({ message: 'Bu şube için aktif personel bulunamadı.' });
		}

		let appointmentId = null;
		let usedStaffId = null;

		for (const candidateId of candidateStaffIds) {
			// Fast pre-check to avoid unnecessary DB attempts.
			const overlap = await appointmentModel.findOverlappingAppointments({ staffId: candidateId, startsAt, endsAt: computedEndsAt });
			if (overlap) continue;
			const googleBusy = await googleCalendar.isStaffBusy({
				staffId: candidateId,
				startsAt: new Date(startsAt),
				endsAt: new Date(computedEndsAt),
			});
			if (googleBusy) continue;

			try {
				appointmentId = await appointmentModel.createAppointment({
					category,
					serviceIds,
					staffId: candidateId,
					startsAt,
					endsAt: computedEndsAt,
					customerFullName,
					customerPhone,
					customerEmail: customerEmail || null,
					notes: notes || null,
					googleEventId: null,
				});
				usedStaffId = candidateId;
				
				// Randevu oluşturulduğunu logla
				businessLogger.logAppointment(
					appointmentId,
					'APPOINTMENT_CREATED',
					{
						staffId: candidateId,
						category,
						serviceCount: serviceIds.length,
						startsAt,
						customerPhone,
					}
				);
				
				break;
			} catch (e) {
				// DB-level conflict (overlap exclusion). For auto-assign, try next staff.
				if (e && e.code === '23P01') {
					if (staffId) {
						return res.status(409).json({ message: 'Seçilen personel bu saatte dolu. Lütfen başka bir saat seçin.' });
					}
					continue;
				}
				throw e;
			}
		}

		if (!appointmentId || !usedStaffId) {
			return res.status(409).json({ message: 'Seçilen saat dolu. Lütfen başka bir saat deneyin.' });
		}

		// Real-time notify (best-effort)
		try {
			const appointment = await appointmentModel.getAppointmentById(appointmentId);
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

				socketService.getIO().to('adminRoom').emit('newAppointment', {
					appointmentId: appointment.id,
					category: appointment.category,
					startsAt: appointment.starts_at,
					endsAt: appointment.ends_at,
					date,
					time,
					customerName: appointment.customer_full_name || '',
					service: services.join(', '),
				});
			}
		} catch (err) {
			logger.warn('[socket] newAppointment emit failed (continuing)', {
				message: err?.message,
				code: err?.code,
				appointmentId,
			});
		}

		// Create Google event AFTER DB insert (best-effort).
		try {
			const googleEventId = await googleCalendar.createEventForAppointment({
				staffId: usedStaffId,
				startsAt: new Date(startsAt),
				endsAt: new Date(computedEndsAt),
				summary: `Randevu - ${customerFullName}`,
				description: `Telefon: ${customerPhone}${customerEmail ? `\nE-posta: ${customerEmail}` : ''}`,
			});
			if (googleEventId) {
				await appointmentModel.setGoogleEventId({ appointmentId, googleEventId });
			}
		} catch (e) {
			console.warn('[google] createEvent failed (continuing):', e.message);
		}

		// Fire-and-forget: email notifications (do not block booking response)
		try {
			const businessEmail = String(getBookingNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
			const contactEmail = String(getInfoEmail() || businessEmail || '').trim();
			const contactPhone = String(process.env.BOOKING_CONTACT_PHONE || '').trim();
			const appointmentIdCopy = appointmentId;
			const usedStaffIdCopy = usedStaffId;
			void (async () => {
				const appointment = await appointmentModel.getAppointmentById(appointmentIdCopy);
				if (!appointment) return;

				const tz = 'Europe/Istanbul';
				const startsLocal = DateTime
					.fromJSDate(new Date(appointment.starts_at), { zone: 'utc' })
					.setZone(tz)
					.setLocale('tr');
				const dateText = startsLocal.toFormat('dd LLLL yyyy');
				const timeText = startsLocal.toFormat('HH:mm');

				const services = Array.isArray(appointment.services) ? appointment.services : [];
				const staffName = String(appointment.staff_full_name || '').trim();
				const customerName = String(appointment.customer_full_name || '').trim();
				const customerPhoneSafe = String(appointment.customer_phone || '').trim();
				const customerEmailSafe = String(appointment.customer_email || '').trim();
				const notesSafe = String(appointment.notes || '').trim();

				if (customerEmailSafe) {
					const html = await getTemplate('booking/booking-success', {
						isReminder: false,
						appointmentId: appointmentIdCopy,
						dateText,
						timeText,
						services,
						staffName,
						customerName,
						contactEmail,
						contactPhone,
					});
					await sendEmail(customerEmailSafe, 'Randevu Onayı', html, {
						channel: 'booking',
						fromEmail: contactEmail || undefined,
						replyTo: contactEmail || undefined,
					});
				}

				// Notify assigned staff (if an email exists)
				try {
					const staff = usedStaffIdCopy ? await staffModel.getStaffById(usedStaffIdCopy) : null;
					const staffEmail = String(staff?.email || '').trim();
					if (staffEmail) {
						const staffHtml = await getTemplate('booking/booking-alert-staff', {
							appointmentId: appointmentIdCopy,
							dateText,
							timeText,
							services,
							staffName,
							customerName,
							customerPhone: customerPhoneSafe,
							customerEmail: customerEmailSafe,
							notes: notesSafe,
						});
						await sendEmail(staffEmail, 'Yeni Randevu', staffHtml, {
							channel: 'booking',
							fromEmail: contactEmail || undefined,
							replyTo: contactEmail || undefined,
						});
					}
				} catch {
					// ignore
				}

				const businessHtml = await getTemplate('booking/booking-alert-admin', {
					appointmentId: appointmentIdCopy,
					dateText,
					timeText,
					services,
					staffName,
					customerName,
					customerPhone: customerPhoneSafe,
					customerEmail: customerEmailSafe,
					notes: notesSafe,
				});
				if (businessEmail) {
					await sendEmail(businessEmail, 'Yeni Randevu Var!', businessHtml, { channel: 'booking' });
				}
			})().catch((err) => {
				logger.error('[booking] booking email notifications failed', {
					message: err?.message,
					code: err?.code,
					appointmentId: appointmentIdCopy,
					stack: err?.stack,
				});
			});
		} catch (err) {
			logger.error('[booking] failed to schedule booking emails', {
				message: err?.message,
				code: err?.code,
				stack: err?.stack,
			});
		}

		res.status(201).json({ appointmentId });
	} catch (err) {
		if (err && (err.code === '23P01' || err.code === '23505')) {
			return res.status(409).json({ message: 'Seçilen saat dolu. Lütfen başka bir saat deneyin.' });
		}
		next(err);
	}
}

module.exports = {
	validateCategory,
	validateAvailability,
	apiListServices,
	apiListStaff,
	apiCheckAvailability,
	apiCreateBooking,
};
