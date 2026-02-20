const { pool } = require('../config/db');

function isUuid(v) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

function normalizeStatus(value) {
	const v = String(value || '').trim().toLowerCase();
	if (v === 'new' || v === 'read' || v === 'archived') return v;
	return 'new';
}

async function createMessage({
	fullName = null,
	email,
	subject = null,
	message,
	createdIp = null,
	userAgent = null,
}) {
	const fn = fullName == null ? null : String(fullName).trim().slice(0, 200) || null;
	const em = String(email || '').trim().toLowerCase().slice(0, 200);
	const sub = subject == null ? null : String(subject).trim().slice(0, 200) || null;
	const msg = String(message || '').trim().slice(0, 5000);
	const ip = createdIp == null ? null : String(createdIp).trim().slice(0, 100) || null;
	const ua = userAgent == null ? null : String(userAgent).trim().slice(0, 500) || null;

	const { rows } = await pool.query(
		`INSERT INTO public_contact_messages (
			full_name,
			email,
			subject,
			message,
			status,
			created_ip,
			user_agent
		) VALUES ($1, $2, $3, $4, 'new', $5, $6)
		RETURNING id, created_at`,
		[fn, em, sub, msg, ip, ua]
	);
	return rows[0] || null;
}

async function listMessages({ status = 'new', limit = 50 } = {}) {
	const st = String(status || 'new').trim().toLowerCase();
	const allowed = new Set(['new', 'read', 'archived', 'all']);
	const normalized = allowed.has(st) ? st : 'new';
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));

	const where = normalized === 'all' ? '' : 'WHERE status = $1';
	const params = normalized === 'all' ? [lim] : [normalized, lim];
	const limitParam = normalized === 'all' ? '$1' : '$2';

	const { rows } = await pool.query(
		`SELECT
			id,
			full_name,
			email,
			subject,
			status,
			created_at,
			updated_at
		FROM public_contact_messages
		${where}
		ORDER BY created_at DESC
		LIMIT ${limitParam}`,
		params
	);
	return rows;
}

async function getMessageById(messageId) {
	if (!isUuid(messageId)) return null;
	const { rows } = await pool.query(
		`SELECT
			id,
			full_name,
			email,
			subject,
			message,
			status,
			created_ip,
			user_agent,
			created_at,
			updated_at
		FROM public_contact_messages
		WHERE id = $1
		LIMIT 1`,
		[messageId]
	);
	return rows[0] || null;
}

async function setMessageStatus({ messageId, status }) {
	if (!isUuid(messageId)) return null;
	const st = normalizeStatus(status);
	const { rows } = await pool.query(
		`UPDATE public_contact_messages
		SET status = $2,
			updated_at = now()
		WHERE id = $1
		RETURNING id, status`,
		[messageId, st]
	);
	return rows[0] || null;
}

module.exports = {
	createMessage,
	listMessages,
	getMessageById,
	setMessageStatus,
};
