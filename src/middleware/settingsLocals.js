const settingsModel = require('../models/settingsModel');
const { getShopBaseUrl } = require('../utils/appBaseUrl');

function computeBrandName(settings) {
	const envBrand = String(process.env.SITE_BRAND_NAME || process.env.EMAIL_FROM_NAME || '').trim();
	const dbBrand = settings && settings.company_name ? String(settings.company_name).trim() : '';
	return dbBrand || envBrand || 'BySamet Erkek Kuaförü';
}

function createSettingsLocalsMiddleware(options = {}) {
	const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : 60_000;

	let cached = null;
	let cachedAt = 0;
	let inFlight = null;

	async function getSettingsCached() {
		const now = Date.now();
		if (cached && (now - cachedAt) < ttlMs) return cached;

		if (!inFlight) {
			inFlight = (async () => {
				try {
					const company = await settingsModel.getCompanySettings();
					cached = company || {};
					cachedAt = Date.now();
					return cached;
				} finally {
					inFlight = null;
				}
			})();
		}

		return inFlight;
	}

	return async function settingsLocals(req, res, next) {
		try {
			res.locals.settings = await getSettingsCached();
			res.locals.brandName = computeBrandName(res.locals.settings);
			res.locals.shopBaseUrl = getShopBaseUrl(req);
			return next();
		} catch {
			// Non-blocking: pages should still render even if DB is down.
			res.locals.settings = {};
			res.locals.brandName = computeBrandName(null);
			res.locals.shopBaseUrl = getShopBaseUrl(req);
			return next();
		}
	};
}

module.exports = {
	createSettingsLocalsMiddleware,
};
