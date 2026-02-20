const userModel = require('../models/userModel');

async function attachShopUser(req, res, next) {
	try {
		const userId = req.session && req.session.userId;
		if (!userId) {
			req.shopUser = null;
			res.locals.shopUser = null;
			res.locals.isShopLoggedIn = false;
			return next();
		}

		const user = await userModel.findById(userId);
		if (!user) {
			// Session stale
			try { delete req.session.userId; } catch { /* ignore */ }
			req.shopUser = null;
			res.locals.shopUser = null;
			res.locals.isShopLoggedIn = false;
			return next();
		}

		req.shopUser = user;
		res.locals.shopUser = user;
		res.locals.isShopLoggedIn = true;
		return next();
	} catch (err) {
		return next(err);
	}
}

function requireShopLogin(req, res, next) {
	if (req.shopUser && req.shopUser.id) return next();
	const nextUrl = encodeURIComponent(req.originalUrl || '/');
	return res.redirect(`/login?next=${nextUrl}`);
}

module.exports = {
	attachShopUser,
	requireShopLogin,
};
