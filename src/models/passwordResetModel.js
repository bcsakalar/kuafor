const { pool } = require('../config/db');

async function createReset({ userId, tokenHash, expiresAt, requestedIp = null, userAgent = null }) {
	const { rows } = await pool.query(
		`INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip, user_agent)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, user_id, token_hash, expires_at, used_at, created_at`,
		[userId, tokenHash, expiresAt, requestedIp, userAgent]
	);
	return rows[0];
}

async function findValidByTokenHash(tokenHash) {
	const { rows } = await pool.query(
		`SELECT id, user_id, token_hash, expires_at, used_at, created_at
		 FROM password_resets
		 WHERE token_hash = $1
		 LIMIT 1`,
		[tokenHash]
	);
	const row = rows[0] || null;
	if (!row) return null;
	if (row.used_at) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) return null;
	return row;
}

async function markUsed(id) {
	await pool.query(
		`UPDATE password_resets
		 SET used_at = now()
		 WHERE id = $1`,
		[id]
	);
}

module.exports = {
	createReset,
	findValidByTokenHash,
	markUsed,
};
