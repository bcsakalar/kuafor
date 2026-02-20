const { pool } = require('../config/db');

function isMissingColumnError(err, columnName) {
	return Boolean(
		err &&
		(err.code === '42703' || /column\s+"[^"]+"\s+does\s+not\s+exist/i.test(String(err.message || ''))) &&
		String(err.message || '').toLowerCase().includes(String(columnName).toLowerCase())
	);
}

async function listStaffByCategory(category) {
	// category: men/women, staff.category can be both
	try {
		const { rows } = await pool.query(
			`SELECT id, full_name, role, category, google_calendar_id
			 FROM staff
			 WHERE is_active = true
				AND (category = $1 OR category = 'both')
			 ORDER BY full_name ASC`,
			[category]
		);
		return rows;
	} catch (err) {
		if (!isMissingColumnError(err, 'role')) throw err;
		const { rows } = await pool.query(
			`SELECT id, full_name, category, google_calendar_id
			 FROM staff
			 WHERE is_active = true
				AND (category = $1 OR category = 'both')
			 ORDER BY full_name ASC`,
			[category]
		);
		return rows.map((r) => ({ ...r, role: null }));
	}
}

async function listAllStaff() {
	try {
		const { rows } = await pool.query(
			`SELECT id, full_name, role, phone, email, category, google_calendar_id, is_active
			 FROM staff
			 ORDER BY is_active DESC, full_name ASC`
		);
		return rows;
	} catch (err) {
		if (!isMissingColumnError(err, 'role')) throw err;
		const { rows } = await pool.query(
			`SELECT id, full_name, phone, email, category, google_calendar_id, is_active
			 FROM staff
			 ORDER BY is_active DESC, full_name ASC`
		);
		return rows.map((r) => ({ ...r, role: null }));
	}
}

async function getStaffById(id) {
	if (!id) return null;
	try {
		const { rows } = await pool.query(
			`SELECT id, full_name, role, phone, email, category, google_calendar_id, is_active
			 FROM staff
			 WHERE id = $1
			 LIMIT 1`,
			[id]
		);
		return rows[0] || null;
	} catch (err) {
		if (!isMissingColumnError(err, 'role')) throw err;
		const { rows } = await pool.query(
			`SELECT id, full_name, phone, email, category, google_calendar_id, is_active
			 FROM staff
			 WHERE id = $1
			 LIMIT 1`,
			[id]
		);
		if (!rows[0]) return null;
		return { ...rows[0], role: null };
	}
}

module.exports = {
	listStaffByCategory,
	listAllStaff,
	getStaffById,
};
