const appointmentModel = require('../models/appointmentModel');
const { DateTime } = require('luxon');
const { logger } = require('../config/logger');
const { sendEmail, getTemplate } = require('../services/emailService');
const { getInfoEmail, getContactNotifyToEmail, getBookingNotifyToEmail } = require('../config/email');

function safeNumber(v, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

async function runOnceMarkCompleted() {
	try {
		const count = await appointmentModel.markCompletedEndedAppointments();
		if (count > 0) logger.info('[lifecycle] marked completed', { count });
	} catch (err) {
		logger.warn('[lifecycle] markCompleted failed', { message: err?.message, code: err?.code });
	}
}

async function runOnceCleanup(daysToKeep) {
	try {
		const count = await appointmentModel.deletePastAppointmentsOlderThan(daysToKeep);
		if (count > 0) logger.info('[lifecycle] cleaned up old appointments', { count, daysToKeep });
	} catch (err) {
		logger.warn('[lifecycle] cleanup failed', { message: err?.message, code: err?.code, daysToKeep });
	}
}

async function runOnceSendReminders() {
	try {
		const ids = await appointmentModel.listAppointmentsNeedingReminder({ limit: 100 });
		if (!ids.length) return;

		const tz = 'Europe/Istanbul';
		for (const id of ids) {
			try {
				const appointment = await appointmentModel.getAppointmentById(id);
				if (!appointment) continue;

				const customerEmail = String(appointment.customer_email || '').trim();
				if (!customerEmail) continue;

				const startsLocal = DateTime
					.fromJSDate(new Date(appointment.starts_at), { zone: 'utc' })
					.setZone(tz)
					.setLocale('tr');
				const dateText = startsLocal.toFormat('dd LLLL yyyy');
				const timeText = startsLocal.toFormat('HH:mm');

				const services = Array.isArray(appointment.services) ? appointment.services : [];
				const staffName = String(appointment.staff_full_name || '').trim();
				const customerName = String(appointment.customer_full_name || '').trim();
				const businessEmail = String(getBookingNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
				const contactEmail = String(getInfoEmail() || businessEmail || '').trim();
				const contactPhone = String(process.env.BOOKING_CONTACT_PHONE || '').trim();

				const html = await getTemplate('booking/booking-success', {
					isReminder: true,
					appointmentId: id,
					dateText,
					timeText,
					services,
					staffName,
					customerName,
					contactEmail,
					contactPhone,
				});
				await sendEmail(customerEmail, 'Hatırlatma: Yarın Randevunuz Var', html, {
					channel: 'booking',
					fromEmail: contactEmail || undefined,
					replyTo: contactEmail || undefined,
				});
				await appointmentModel.markReminderSent({ appointmentId: id });
			} catch (err) {
				logger.error('[lifecycle] reminder email failed', {
					message: err?.message,
					code: err?.code,
					appointmentId: id,
					stack: err?.stack,
				});
			}
		}

		logger.info('[lifecycle] reminders sent (attempted)', { count: ids.length });
	} catch (err) {
		// If DB isn't migrated yet, disable reminders quietly.
		if (err?.code === '42703' && String(err?.message || '').toLowerCase().includes('reminder_sent_at')) {
			logger.warn('[lifecycle] reminder_sent_at missing; reminders disabled until DB migrate', {
				hint: 'Run: node scripts/db-migrate.js',
			});
			return;
		}
		logger.warn('[lifecycle] reminders failed', { message: err?.message, code: err?.code });
	}
}

function startAppointmentLifecycleJobs(opts = {}) {
	const markIntervalMs = safeNumber(opts.markIntervalMs, 5 * 60 * 1000);
	const cleanupIntervalMs = safeNumber(opts.cleanupIntervalMs, 12 * 60 * 60 * 1000);
	const cleanupDaysToKeep = safeNumber(opts.cleanupDaysToKeep, 14);
	const reminderIntervalMs = safeNumber(opts.reminderIntervalMs, 15 * 60 * 1000);

	// Run at startup
	runOnceMarkCompleted();
	runOnceCleanup(cleanupDaysToKeep);
	runOnceSendReminders();

	setInterval(runOnceMarkCompleted, markIntervalMs).unref?.();
	setInterval(() => runOnceCleanup(cleanupDaysToKeep), cleanupIntervalMs).unref?.();
	setInterval(runOnceSendReminders, reminderIntervalMs).unref?.();

	logger.info('[lifecycle] jobs started', {
		markIntervalMs,
		cleanupIntervalMs,
		cleanupDaysToKeep,
		reminderIntervalMs,
	});
}

module.exports = { startAppointmentLifecycleJobs };
