const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

async function countAdmins() {
	const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM admins');
	return rows[0]?.c || 0;
}

async function findByEmail(email) {
	const normalized = String(email).trim().toLowerCase();
	const { rows } = await pool.query(
		`SELECT id, email, password_hash, full_name, role
		 FROM admins
		 WHERE email = $1
		 LIMIT 1`,
		[normalized]
	);
	return rows[0] || null;
}

async function findById(id) {
	const { rows } = await pool.query(
		`SELECT id, email, full_name, role
		 FROM admins
		 WHERE id = $1
		 LIMIT 1`,
		[id]
	);
	return rows[0] || null;
}

async function findByIdWithPasswordHash(id) {
	const { rows } = await pool.query(
		`SELECT id, email, password_hash, full_name, role
		 FROM admins
		 WHERE id = $1
		 LIMIT 1`,
		[id]
	);
	return rows[0] || null;
}

async function createAdmin({ email, password, fullName }) {
	const normalized = String(email).trim().toLowerCase();
	const passwordHash = await bcrypt.hash(String(password), 12);
	const { rows } = await pool.query(
		`INSERT INTO admins (email, password_hash, full_name)
		 VALUES ($1, $2, $3)
		 RETURNING id, email, full_name, role`,
		[normalized, passwordHash, fullName || null]
	);
	return rows[0];
}

async function verifyPassword({ password, passwordHash }) {
	return bcrypt.compare(String(password), String(passwordHash));
}

async function updateCredentials({ adminId, newEmail, newPassword }) {
	const normalizedEmail = (newEmail == null) ? '' : String(newEmail).trim().toLowerCase();
	// Safety: never allow setting email to an empty string.
	const wantsEmail = Boolean(normalizedEmail);
	const wantsPassword = Boolean(newPassword);
	if (!wantsEmail && !wantsPassword) return null;

	const sets = [];
	const values = [];
	let idx = 1;

	if (wantsEmail) {
		sets.push(`email = $${idx++}`);
		values.push(normalizedEmail);
	}

	if (wantsPassword) {
		const passwordHash = await bcrypt.hash(String(newPassword), 12);
		sets.push(`password_hash = $${idx++}`);
		values.push(passwordHash);
	}

	sets.push('updated_at = now()');
	values.push(adminId);

	const { rows } = await pool.query(
		`UPDATE admins
		 SET ${sets.join(', ')}
		 WHERE id = $${idx}
		 RETURNING id, email, full_name, role`,
		values
	);
	return rows[0] || null;
}

module.exports = {
	countAdmins,
	findByEmail,
	findById,
	findByIdWithPasswordHash,
	createAdmin,
	verifyPassword,
	updateCredentials,
};
