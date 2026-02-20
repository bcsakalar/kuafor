function isLocalhostHostname(hostname) {
	const h = String(hostname || '').toLowerCase();
	return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
}

function normalizeAdminPathPrefix(v) {
	const s = String(v || '').trim();
	if (!s) return null;
	if (s === '/') return null;
	return s.startsWith('/') ? s : `/${s}`;
}

function getAdminHostnamePrefix() {
	const raw = String(process.env.ADMIN_HOSTNAME_PREFIX || 'admin.').trim().toLowerCase();
	return raw || null;
}

function computeAdminRouting(req) {
	const hostname = (req.hostname || '').toLowerCase();
	const adminHostnamePrefix = getAdminHostnamePrefix();
	const adminPathPrefix = normalizeAdminPathPrefix(process.env.ADMIN_PATH_PREFIX || '/admin');
	const isAdminHost = Boolean(adminHostnamePrefix && hostname.startsWith(adminHostnamePrefix));
	const isLocalhost = isLocalhostHostname(hostname);

	// Admin routing:
	// - If hostname is admin.* (including admin.localhost), admin lives at root (no /admin prefix)
	// - Otherwise (e.g. localhost), admin lives under /admin for convenience
	const subdomainRoot = isAdminHost;
	const basePath = subdomainRoot ? '' : (adminPathPrefix || '/admin');

	const isAdminPath = adminPathPrefix
		? (req.path === adminPathPrefix || req.path.startsWith(`${adminPathPrefix}/`))
		: false;

	return {
		hostname,
		adminHostnamePrefix,
		adminPathPrefix,
		isAdminHost,
		isLocalhost,
		subdomainRoot,
		adminBasePath: basePath,
		adminApiBasePath: basePath ? `${basePath}/api` : '/api',
		isAdminContext: Boolean(isAdminHost),
	};
}

function detectAdminContext() {
	return function adminContextMiddleware(req, res, next) {
		const ctx = computeAdminRouting(req);
		req.isAdminContext = ctx.isAdminContext;
		req.adminBasePath = ctx.adminBasePath;
		req.adminApiBasePath = ctx.adminApiBasePath;
		req.isAdminHost = ctx.isAdminHost;
		req.isAdminSubdomain = ctx.subdomainRoot;

		res.locals.adminBasePath = ctx.adminBasePath;
		res.locals.adminApiBasePath = ctx.adminApiBasePath;
		next();
	};
}

module.exports = {
	detectAdminContext,
	computeAdminRouting,
};
