function normalizeUrlString(value) {
	const s = String(value || '').trim();
	if (!s) return '';
	return s.replace(/\/+$/, '');
}

function normalizeHttpOrigin(raw) {
	const s = normalizeUrlString(raw);
	if (!s) return '';
	try {
		const u = new URL(s);
		const proto = String(u.protocol || '').toLowerCase();
		if (proto !== 'http:' && proto !== 'https:') return '';
		return normalizeUrlString(u.origin);
	} catch {
		return '';
	}
}

function parseAppBaseUrls(raw) {
	const input = String(raw || '').trim();
	if (!input) return [];

	const parts = input
		.split(',')
		.map((s) => normalizeUrlString(s))
		.filter(Boolean);

	// Keep only http/https absolute URLs.
	const urls = [];
	for (const p of parts) {
		try {
			const u = new URL(p);
			const proto = String(u.protocol || '').toLowerCase();
			if (proto === 'http:' || proto === 'https:') urls.push(normalizeUrlString(u.toString()));
		} catch {
			// ignore invalid entries
		}
	}
	return urls;
}

function getEnvBaseUrl(name) {
	return normalizeHttpOrigin(process.env[name]);
}

function getPrimaryConfiguredBaseUrl() {
	// Prefer explicit new vars first.
	const direct =
		getEnvBaseUrl('APP_BASE_URL')
		|| getEnvBaseUrl('SHOP_BASE_URL')
		|| getEnvBaseUrl('ADMIN_BASE_URL')
		|| getEnvBaseUrl('SHOPADMIN_BASE_URL');
	if (direct) return direct;

	// Back-compat: APP_BASE_URL may be a comma-separated list.
	const legacyFirst = parseAppBaseUrls(process.env.APP_BASE_URL)[0] || '';
	return normalizeHttpOrigin(legacyFirst);
}

function getHostnameFromReq(req) {
	if (!req) return '';
	// Prefer proxy headers when behind nginx.
	const xfHost = String(req.headers['x-forwarded-host'] || '').trim().split(',')[0].trim();
	const hostHeader = String(req.get && req.get('host') ? req.get('host') : '').trim().split(',')[0].trim();
	const host = xfHost || hostHeader || String(req.hostname || '').trim();
	return String(host || '').split(':')[0].trim().toLowerCase();
}

function isLocalhostHostname(hostname) {
	const h = String(hostname || '').toLowerCase();
	return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
}

function detectHostContext(req) {
	const hostname = getHostnameFromReq(req);
	const adminPrefix = String(process.env.ADMIN_HOSTNAME_PREFIX || 'admin.').trim().toLowerCase();
	const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
	const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
	const allowShopOnLocalhost = process.env.SHOP_ALLOW_LOCALHOST === '1';
	const isLocalhost = isLocalhostHostname(hostname);

	const isAdminHost = Boolean(adminPrefix && hostname.startsWith(adminPrefix));
	const isShopAdminHost = Boolean(shopAdminPrefix && hostname.startsWith(shopAdminPrefix));
	const isLocalShopHost = Boolean(
		allowShopOnLocalhost
			&& isLocalhost
			&& (hostname === 'localhost' || hostname === '127.0.0.1')
	);
	const isShopHost = Boolean((shopPrefix && hostname.startsWith(shopPrefix)) || isLocalShopHost);

	if (isAdminHost) return { type: 'admin', hostname };
	if (isShopAdminHost) return { type: 'shopadmin', hostname };
	if (isShopHost) return { type: 'shop', hostname };
	return { type: 'app', hostname };
}

function swapHostnamePrefix(origin, fromPrefix, toPrefix) {
	const base = normalizeHttpOrigin(origin);
	if (!base) return '';
	const from = String(fromPrefix || '').trim().toLowerCase();
	const to = String(toPrefix || '').trim().toLowerCase();
	if (!from || !to) return '';
	try {
		const u = new URL(base);
		const host = String(u.hostname || '').toLowerCase();
		if (!host.startsWith(from)) return '';
		u.hostname = to + host.slice(from.length);
		return normalizeUrlString(u.origin);
	} catch {
		return '';
	}
}

function addHostnamePrefix(origin, prefix) {
	const base = normalizeHttpOrigin(origin);
	if (!base) return '';
	const p = String(prefix || '').trim().toLowerCase();
	if (!p) return base;
	try {
		const u = new URL(base);
		let host = String(u.hostname || '').toLowerCase();
		if (!host) return base;
		// Normalize away the common www. prefix.
		if (host.startsWith('www.')) host = host.slice(4);
		// If it's already prefixed, keep as-is.
		if (host.startsWith(p)) return base;
		// Only prefix real domains (avoid localhost-like hosts).
		if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return base;
		u.hostname = p + host;
		return normalizeUrlString(u.origin);
	} catch {
		return base;
	}
}

function getRequestBaseUrl(req) {
	if (!req) return '';
	// Prefer explicit proxy headers; fall back to Cloudflare's cf-visitor scheme when available.
	let proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
	if (!proto) {
		const cfVisitor = String(req.headers['cf-visitor'] || '').trim();
		if (cfVisitor) {
			try {
				const parsed = JSON.parse(cfVisitor);
				if (parsed && typeof parsed.scheme === 'string' && parsed.scheme) proto = String(parsed.scheme);
			} catch {
				// ignore
			}
		}
	}
	if (!proto) {
		const xfSsl = String(req.headers['x-forwarded-ssl'] || '').trim().toLowerCase();
		if (xfSsl === 'on') proto = 'https';
	}
	if (!proto) {
		try {
			if (req.secure === true) proto = 'https';
		} catch {
			// ignore
		}
	}
	proto = (proto || req.protocol || 'http').toString().split(',')[0].trim() || 'http';
	const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').trim().split(',')[0].trim();
	return host ? `${proto}://${host}` : '';
}

function pickAppBaseUrlFromList(req, urls) {
	const list = Array.isArray(urls) ? urls : [];
	if (list.length === 0) return '';
	if (!req) return list[0];

	const reqHost = String(req.headers['x-forwarded-host'] || req.get('host') || '').trim().split(',')[0].trim().toLowerCase();
	if (!reqHost) return list[0];

	for (const u of list) {
		try {
			const parsed = new URL(u);
			const host = String(parsed.host || '').toLowerCase();
			if (host === reqHost) return normalizeUrlString(parsed.origin);
		} catch {
			// ignore
		}
	}

	// If none match, prefer the current request host (helps local/dev where APP_BASE_URL
	// might be set to production domains).
	const reqBase = normalizeUrlString(getRequestBaseUrl(req));
	if (reqBase) return reqBase;

	return list[0];
}

function getAppBaseUrl(req, envValue = process.env.APP_BASE_URL) {
	// Prefer explicit per-surface base URLs if present.
	const ctx = detectHostContext(req);
	const envByType = {
		app: 'APP_BASE_URL',
		shop: 'SHOP_BASE_URL',
		shopadmin: 'SHOPADMIN_BASE_URL',
		admin: 'ADMIN_BASE_URL',
	};
	const direct = getEnvBaseUrl(envByType[ctx.type]);
	if (direct) return direct;

	// Back-compat: allow comma-separated list (or single value) via envValue.
	const configuredList = parseAppBaseUrls(envValue);
	const picked = pickAppBaseUrlFromList(req, configuredList);
	if (picked) return picked;
	return normalizeUrlString(getRequestBaseUrl(req));
}

function getShopBaseUrl(req) {
	const direct = getEnvBaseUrl('SHOP_BASE_URL');
	if (direct) return direct;
	const base = getAppBaseUrl(req);
	const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
	const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
	// If request is on the main domain, prefer the shop subdomain (shop.<domain>) for shop URLs.
	return (
		swapHostnamePrefix(base, shopAdminPrefix, shopPrefix)
		|| addHostnamePrefix(base, shopPrefix)
		|| base
	);
}

function getShopAdminBaseUrl(req) {
	const direct = getEnvBaseUrl('SHOPADMIN_BASE_URL');
	if (direct) return direct;
	const base = getAppBaseUrl(req);
	const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
	const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
	return swapHostnamePrefix(base, shopPrefix, shopAdminPrefix) || base;
}

function getAdminBaseUrl(req) {
	const direct = getEnvBaseUrl('ADMIN_BASE_URL');
	if (direct) return direct;
	return getAppBaseUrl(req);
}

module.exports = {
	normalizeHttpOrigin,
	parseAppBaseUrls,
	getPrimaryConfiguredBaseUrl,
	getHostnameFromReq,
	detectHostContext,
	swapHostnamePrefix,
	addHostnamePrefix,
	getRequestBaseUrl,
	pickAppBaseUrlFromList,
	getAppBaseUrl,
	getShopBaseUrl,
	getShopAdminBaseUrl,
	getAdminBaseUrl,
};