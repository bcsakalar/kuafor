const { pool } = require('../config/db');

async function listServicesByCategory(category) {
	const { rows } = await pool.query(
		`SELECT id, name, duration_minutes, price_cents, category
		 FROM services
		 WHERE is_active = true AND category = $1
		 ORDER BY name ASC`,
		[category]
	);
	return rows;
}

async function listAllServices() {
	const { rows } = await pool.query(
		`SELECT id, name, duration_minutes, price_cents, category, is_active
		 FROM services
		 ORDER BY category ASC, name ASC`
	);
	return rows;
}

module.exports = {
	listServicesByCategory,
	listAllServices,
};
