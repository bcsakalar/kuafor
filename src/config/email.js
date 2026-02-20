function readStringEnv(key, fallback = '') {
	const v = process.env[key];
	if (v === undefined || v === null) return fallback;
	const s = String(v).trim();
	return s ? s : fallback;
}

function getBrevoApiKey() {
	return readStringEnv('BREVO_API_KEY', '');
}

function getDefaultSender() {
	return {
		email: readStringEnv('EMAIL_FROM_EMAIL', ''),
		name: readStringEnv('EMAIL_FROM_NAME', ''),
	};
}

function getInfoEmail() {
	return readStringEnv('EMAIL_INFO_EMAIL', '');
}

function getContactNotifyToEmail() {
	return readStringEnv('CONTACT_NOTIFY_TO_EMAIL', '');
}

// Shop order notifications (new order, refunds, cancellations, low stock, etc.)
function getShopNotifyToEmail() {
	return readStringEnv(
		'SHOP_NOTIFY_TO_EMAIL',
		readStringEnv('CONTACT_NOTIFY_TO_EMAIL', readStringEnv('ADMIN_EMAIL', ''))
	);
}

// Booking (appointment) notifications
function getBookingNotifyToEmail() {
	return readStringEnv(
		'BOOKING_NOTIFY_TO_EMAIL',
		readStringEnv('CONTACT_NOTIFY_TO_EMAIL', readStringEnv('ADMIN_EMAIL', ''))
	);
}

// Helper: allow per-send override while keeping a simple default.
// opts can be { fromEmail, fromName }.
function getSenderEmailFromEnv(opts) {
	const base = getDefaultSender();
	const fromEmail = readStringEnv('EMAIL_FROM_EMAIL', base.email);
	const fromName = readStringEnv('EMAIL_FROM_NAME', base.name);

	const overrideEmail = opts && typeof opts === 'object' ? String(opts.fromEmail || '').trim() : '';
	const overrideName = opts && typeof opts === 'object' ? String(opts.fromName || '').trim() : '';

	return {
		email: overrideEmail || fromEmail,
		name: overrideName || fromName,
	};
}

module.exports = {
	getBrevoApiKey,
	getDefaultSender,
	getInfoEmail,
	getContactNotifyToEmail,
	getShopNotifyToEmail,
	getBookingNotifyToEmail,
	getSenderEmailFromEnv,
};
