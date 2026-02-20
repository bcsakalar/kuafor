const { pool } = require('../config/db');

const COMPANY_SETTINGS_KEY = 'company';

function toNullIfBlank(v) {
	if (v == null) return null;
	const s = String(v).trim();
	return s ? s : null;
}

async function ensureCompanyRow() {
	// Keep value jsonb non-null to satisfy schema.
	await pool.query(
		`INSERT INTO settings (key, value, updated_at)
		 VALUES ($1, '{}'::jsonb, now())
		 ON CONFLICT (key) DO NOTHING`,
		[COMPANY_SETTINGS_KEY]
	);
}

async function getSettingJson(key, defaultValue) {
	const k = String(key || '').trim();
	if (!k) throw new Error('key required');
	const { rows } = await pool.query(
		`SELECT value
		 FROM settings
		 WHERE key = $1`,
		[k]
	);
	if (!rows[0]) return defaultValue;
	return rows[0].value;
}

async function setSettingJson(key, value) {
	const k = String(key || '').trim();
	if (!k) throw new Error('key required');
	await pool.query(
		`INSERT INTO settings (key, value, updated_at)
		 VALUES ($1, $2::jsonb, now())
		 ON CONFLICT (key)
		 DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		[k, JSON.stringify(value ?? null)]
	);
	return true;
}

async function getCompanySettings() {
	// Row may not exist yet; treat missing as empty.
	const { rows } = await pool.query(
		`SELECT
			company_name,
			tax_office,
			tax_number,
			mersis_number,
			kep_address,
			trade_registry_number,
			contact_address,
			contact_phone,
			contact_email,
			representative_name,
			updated_at
		 FROM settings
		 WHERE key = $1`,
		[COMPANY_SETTINGS_KEY]
	);
	const r = rows[0];
	if (!r) {
		return {
			company_name: null,
			tax_office: null,
			tax_number: null,
			mersis_number: null,
			kep_address: null,
			trade_registry_number: null,
			contact_address: null,
			contact_phone: null,
			contact_email: null,
			representative_name: null,
			updated_at: null,
		};
	}
	return {
		company_name: r.company_name ?? null,
		tax_office: r.tax_office ?? null,
		tax_number: r.tax_number ?? null,
		mersis_number: r.mersis_number ?? null,
		kep_address: r.kep_address ?? null,
		trade_registry_number: r.trade_registry_number ?? null,
		contact_address: r.contact_address ?? null,
		contact_phone: r.contact_phone ?? null,
		contact_email: r.contact_email ?? null,
		representative_name: r.representative_name ?? null,
		updated_at: r.updated_at ?? null,
	};
}

async function updateCompanySettings(input) {
	await ensureCompanyRow();

	const payload = {
		company_name: toNullIfBlank(input?.company_name),
		tax_office: toNullIfBlank(input?.tax_office),
		tax_number: toNullIfBlank(input?.tax_number),
		mersis_number: toNullIfBlank(input?.mersis_number),
		kep_address: toNullIfBlank(input?.kep_address),
		trade_registry_number: toNullIfBlank(input?.trade_registry_number),
		contact_address: toNullIfBlank(input?.contact_address),
		contact_phone: toNullIfBlank(input?.contact_phone),
		contact_email: toNullIfBlank(input?.contact_email),
		representative_name: toNullIfBlank(input?.representative_name),
	};

	await pool.query(
		`UPDATE settings
		 SET
		 	company_name = $2,
		 	tax_office = $3,
		 	tax_number = $4,
		 	mersis_number = $5,
		 	kep_address = $6,
		 	trade_registry_number = $7,
		 	contact_address = $8,
		 	contact_phone = $9,
		 	contact_email = $10,
		 	representative_name = $11,
		 	updated_at = now()
		 WHERE key = $1`,
		[
			COMPANY_SETTINGS_KEY,
			payload.company_name,
			payload.tax_office,
			payload.tax_number,
			payload.mersis_number,
			payload.kep_address,
			payload.trade_registry_number,
			payload.contact_address,
			payload.contact_phone,
			payload.contact_email,
			payload.representative_name,
		]
	);

	return true;
}

module.exports = {
	getSettingJson,
	setSettingJson,
	getCompanySettings,
	updateCompanySettings,
};
