function requireAdminPage(req, res, next) {
	if (req.session && req.session.adminId) return next();
	const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
	return res.redirect(base ? `${base}/login` : '/login');
}

function requireAdminApi(req, res, next) {
	if (req.session && req.session.adminId) return next();
	return res.status(401).json({ ok: false, message: 'Unauthorized' });
}

module.exports = {
	requireAdminPage,
	requireAdminApi,
};
