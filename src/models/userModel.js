const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

function normalizeEmail(email) {
	return String(email || '').trim().toLowerCase();
}

async function findByEmail(email) {
	const normalized = normalizeEmail(email);
	if (!normalized) return null;
	const { rows } = await pool.query(
		`SELECT id, email, password_hash, full_name, phone, role, created_at
		 FROM users
		 WHERE email = $1
		 LIMIT 1`,
		[normalized]
	);
	return rows[0] || null;
}

async function findById(id) {
	if (!id) return null;
	const { rows } = await pool.query(
		`SELECT id, email, full_name, phone, role, created_at
		 FROM users
		 WHERE id = $1
		 LIMIT 1`,
		[id]
	);
	return rows[0] || null;
}

async function createUser({ email, password, fullName = null, phone = null, role = 'customer' }) {
	const normalizedEmail = normalizeEmail(email);
	if (!normalizedEmail) {
		const err = new Error('Email is required');
		err.statusCode = 400;
		throw err;
	}
	if (!password || String(password).length < 6) {
		const err = new Error('Password too short');
		err.statusCode = 400;
		throw err;
	}

	const passwordHash = await bcrypt.hash(String(password), 12);
	try {
		const { rows } = await pool.query(
			`INSERT INTO users (email, password_hash, full_name, phone, role, auth_provider)
			 VALUES ($1, $2, $3, $4, $5, 'local')
			 RETURNING id, email, full_name, phone, role, created_at`,
			[
				normalizedEmail,
				passwordHash,
				fullName ? String(fullName).trim() : null,
				phone ? String(phone).trim() : null,
				String(role || 'customer').trim() || 'customer',
			]
		);
		return rows[0];
	} catch (e) {
		// unique_violation
		if (e && e.code === '23505') {
			const err = new Error('Email already in use');
			err.statusCode = 409;
			throw err;
		}
		throw e;
	}
}

async function upsertGoogleUser({ email, fullName = null, phone = null, googleSub }) {
	const normalizedEmail = normalizeEmail(email);
	const sub = String(googleSub || '').trim();
	if (!normalizedEmail) {
		const err = new Error('Email is required');
		err.statusCode = 400;
		throw err;
	}
	if (!sub) {
		const err = new Error('Google sub is required');
		err.statusCode = 400;
		throw err;
	}

	// If a user already exists by email, link the google_sub (best-effort) and return.
	const existing = await findByEmail(normalizedEmail);
	if (existing) {
		await pool.query(
			`UPDATE users
			 SET
				google_sub = COALESCE(users.google_sub, $2),
				auth_provider = CASE
					WHEN users.auth_provider = 'local' THEN users.auth_provider
					ELSE 'google'
				END,
				full_name = COALESCE($3, users.full_name),
				phone = COALESCE($4, users.phone)
			 WHERE id = $1`,
			[
				existing.id,
				sub,
				fullName ? String(fullName).trim() : null,
				phone ? String(phone).trim() : null,
			]
		);
		return await findById(existing.id);
	}

	// Create new google user.
	try {
		const { rows } = await pool.query(
			`INSERT INTO users (email, password_hash, full_name, phone, role, auth_provider, google_sub)
			 VALUES ($1, NULL, $2, $3, 'customer', 'google', $4)
			 RETURNING id`,
			[
				normalizedEmail,
				fullName ? String(fullName).trim() : null,
				phone ? String(phone).trim() : null,
				sub,
			]
		);
		return await findById(rows[0].id);
	} catch (e) {
		if (e && e.code === '23505') {
			// Unique collision: sub or email. Fall back to fetch by email.
			const again = await findByEmail(normalizedEmail);
			if (again) return await findById(again.id);
		}
		throw e;
	}
}

async function verifyPassword({ password, passwordHash }) {
	if (!passwordHash) return false;
	return bcrypt.compare(String(password || ''), String(passwordHash));
}

async function updatePasswordById({ userId, newPassword }) {
	if (!userId) {
		const err = new Error('userId is required');
		err.statusCode = 400;
		throw err;
	}
	if (!newPassword || String(newPassword).length < 6) {
		const err = new Error('Password too short');
		err.statusCode = 400;
		throw err;
	}

	const passwordHash = await bcrypt.hash(String(newPassword), 12);
	await pool.query(
		`UPDATE users
		 SET password_hash = $2
		 WHERE id = $1`,
		[userId, passwordHash]
	);
}

module.exports = {
	findByEmail,
	findById,
	createUser,
	upsertGoogleUser,
	verifyPassword,
	updatePasswordById,
};
