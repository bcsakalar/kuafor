const adminModel = require('../models/adminModel');
const userModel = require('../models/userModel');
const cartModel = require('../models/cartModel');
const googleShopAuth = require('../services/googleShopAuth');
const shopOAuthBridge = require('../services/shopOAuthBridge');
const { logger } = require('../config/logger');
const { getTemplate, sendEmail } = require('../services/emailService');
const { getAppBaseUrl } = require('../utils/appBaseUrl');
const passwordResetModel = require('../models/passwordResetModel');
const crypto = require('crypto');

function getRequestOrigin(req) {
	const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').split(',')[0].trim();
	const host = String(req?.headers?.['x-forwarded-host'] || (req?.get ? req.get('host') : '') || '').split(',')[0].trim();
	return host ? `${proto}://${host}` : '';
}

function renderLogin(req, res) {
	res.render('admin/login', {
		title: 'Admin Giriş',
		layout: 'layouts/admin',
		hideAdminNav: true,
		error: req.query.error ? 'E-posta veya şifre hatalı.' : null,
		success: String(req.query.ok || '').trim() === '1' ? 'Bilgiler güncellendi. Lütfen tekrar giriş yapın.' : null,
	});
}

async function adminLogin(req, res, next) {
	try {
		const { email, password } = req.body;
		const admin = await adminModel.findByEmail(email);
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		const loginUrl = base ? `${base}/login?error=1` : '/login?error=1';
		if (!admin) return res.redirect(loginUrl);

		const ok = await adminModel.verifyPassword({ password, passwordHash: admin.password_hash });
		if (!ok) return res.redirect(loginUrl);

		// Session regeneration for security (prevent session fixation)
		await new Promise((resolve) => {
			req.session.regenerate((err) => {
				if (err) {
					logger.warn('[auth] session regenerate failed on admin login', { message: err?.message });
				}
				resolve();
			});
		});
		
		req.session.adminId = admin.id;
		return req.session.save(() => res.redirect(base || '/'));
	} catch (err) {
		next(err);
	}
}

async function adminLogout(req, res) {
	try {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		req.session.destroy(() => {
			res.clearCookie('connect.sid');
			res.redirect(base ? `${base}/login` : '/login');
		});
	} catch {
		const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
		res.redirect(base ? `${base}/login` : '/login');
	}
}

function renderShopLogin(req, res) {
	res.render('shop/login', {
		title: 'Giriş Yap',
		layout: 'layouts/shop',
		error: req.query.error ? 'E-posta veya şifre hatalı.' : null,
		nextUrl: String(req.query.next || '').trim() || '/',
	});
}

function renderShopRegister(req, res) {
	res.render('shop/register', {
		title: 'Kayıt Ol',
		layout: 'layouts/shop',
		error: req.query.error ? String(req.query.error) : null,
		nextUrl: String(req.query.next || '').trim() || '/',
	});
}

function renderForgotPassword(req, res) {
	const sent = String(req.query.sent || '').trim() === '1';
	const hasError = String(req.query.err || '').trim() === '1';
	res.render('shop/forgot-password', {
		title: 'Şifremi Unuttum',
		layout: 'layouts/shop',
		sent,
		hasError,
	});
}

async function forgotPassword(req, res, next) {
	try {
		const email = String(req.body?.email || '').trim().toLowerCase();
		// Always respond success (do not leak account existence)
		const okRedirect = () => res.redirect('/forgot-password?sent=1');
		if (!email || email.length > 200 || !email.includes('@')) return okRedirect();

		const user = await userModel.findByEmail(email);
		if (!user) return okRedirect();

		const appBaseUrl = getAppBaseUrl(req);
		if (!appBaseUrl) {
			logger.warn('[auth] APP_BASE_URL missing; cannot generate reset link');
			return okRedirect();
		}

		const ttlMinutes = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 60);
		const safeTtl = Number.isFinite(ttlMinutes) && ttlMinutes > 5 && ttlMinutes <= 24 * 60 ? ttlMinutes : 60;

		const token = crypto.randomBytes(32).toString('hex');
		const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
		const expiresAt = new Date(Date.now() + safeTtl * 60 * 1000);

		await passwordResetModel.createReset({
			userId: user.id,
			tokenHash,
			expiresAt,
			requestedIp: req.ip,
			userAgent: req.get('user-agent'),
		});

		const resetUrl = `${appBaseUrl.replace(/\/$/, '')}/reset-password/${token}`;
		try {
			const html = await getTemplate('reset-password', { resetUrl, email: user.email });
			await sendEmail(user.email, 'Şifre Sıfırlama', html, { channel: 'shop' });
		} catch (err) {
			logger.error('[auth] reset email failed', {
				message: err?.message,
				code: err?.code,
				userEmail: user.email,
				stack: err?.stack,
			});
		}

		return okRedirect();
	} catch (err) {
		next(err);
	}
}

function renderResetPassword(req, res) {
	const token = String(req.params?.token || '').trim();
	const hasError = String(req.query.err || '').trim() === '1';
	res.render('shop/reset-password', {
		title: 'Şifre Sıfırlama',
		layout: 'layouts/shop',
		token,
		hasError,
	});
}

async function resetPassword(req, res, next) {
	try {
		const token = String(req.params?.token || '').trim();
		const password = String(req.body?.password || '');
		const passwordConfirm = String(req.body?.passwordConfirm || '');

		if (!token || token.length < 40) return res.redirect(`/reset-password/${encodeURIComponent(token)}?err=1`);
		if (!password || password.length < 6 || password.length > 200) return res.redirect(`/reset-password/${encodeURIComponent(token)}?err=1`);
		if (password !== passwordConfirm) return res.redirect(`/reset-password/${encodeURIComponent(token)}?err=1`);

		const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
		const reset = await passwordResetModel.findValidByTokenHash(tokenHash);
		if (!reset) return res.redirect(`/reset-password/${encodeURIComponent(token)}?err=1`);

		await userModel.updatePasswordById({ userId: reset.user_id, newPassword: password });
		await passwordResetModel.markUsed(reset.id);

		// Optionally log out all sessions would be ideal; out of scope.
		return res.redirect('/login');
	} catch (err) {
		next(err);
	}
}

async function register(req, res, next) {
	try {
		const { email, password, fullName, phone } = req.body;
		const nextUrl = String(req.body.next || req.query.next || '').trim() || '/';

		const existing = await userModel.findByEmail(email);
		if (existing) {
			return res.redirect(`/register?error=${encodeURIComponent('Bu e-posta zaten kayıtlı.')}&next=${encodeURIComponent(nextUrl)}`);
		}

		const user = await userModel.createUser({ email, password, fullName, phone, role: 'customer' });
		
		// Session regeneration for security (prevent session fixation)
		const sessionCartItems = req.session && req.session.cart && Array.isArray(req.session.cart.items)
			? [...req.session.cart.items]
			: [];
		
		await new Promise((resolve, reject) => {
			req.session.regenerate((err) => {
				if (err) {
					logger.warn('[auth] session regenerate failed on register', { message: err?.message });
					// Continue anyway - not blocking
				}
				resolve();
			});
		});
		
		req.session.userId = user.id;

		// Best-effort: send welcome email
		try {
			const html = await getTemplate('shop/welcome', {
				appBaseUrl: getAppBaseUrl(req),
				fullName: user.full_name || fullName || '',
				email: user.email,
			});
			await sendEmail(user.email, 'Mağazamıza Hoş Geldin', html, { channel: 'shop' });
		} catch (err) {
			logger.error('[auth] welcome email failed', {
				message: err?.message,
				code: err?.code,
				userEmail: email,
				stack: err?.stack,
			});
		}

		// Merge guest session cart into DB cart
		try {
			await cartModel.mergeSessionCartIntoUserCart({ userId: user.id, sessionCartItems: sessionCartItems });
			if (req.session) req.session.cart = { items: [] };
		} catch {
			// best-effort; do not block auth
		}

		return res.redirect(nextUrl);
	} catch (err) {
		next(err);
	}
}

async function login(req, res, next) {
	try {
		const { email, password } = req.body;
		const nextUrl = String(req.body.next || req.query.next || '').trim() || '/';
		const loginUrl = `/login?error=1&next=${encodeURIComponent(nextUrl)}`;

		const user = await userModel.findByEmail(email);
		if (!user) return res.redirect(loginUrl);

		const ok = await userModel.verifyPassword({ password, passwordHash: user.password_hash });
		if (!ok) return res.redirect(loginUrl);

		// Session regeneration for security (prevent session fixation)
		const sessionCartItems = req.session && req.session.cart && Array.isArray(req.session.cart.items)
			? [...req.session.cart.items]
			: [];
		
		await new Promise((resolve, reject) => {
			req.session.regenerate((err) => {
				if (err) {
					logger.warn('[auth] session regenerate failed on login', { message: err?.message });
					// Continue anyway - not blocking
				}
				resolve();
			});
		});
		
		req.session.userId = user.id;

		// Merge guest session cart into DB cart
		try {
			await cartModel.mergeSessionCartIntoUserCart({ userId: user.id, sessionCartItems: sessionCartItems });
			if (req.session) req.session.cart = { items: [] };
		} catch {
			// best-effort; do not block auth
		}

		return res.redirect(nextUrl);
	} catch (err) {
		next(err);
	}
}

async function beginGoogleLogin(req, res, next) {
	try {
		const nextUrl = String(req.query.next || '').trim() || '/';
		const resolvedRedirectUri = googleShopAuth.getResolvedRedirectUri(req);
		if (!resolvedRedirectUri) {
			return res.redirect(`/login?error=1&next=${encodeURIComponent(nextUrl)}`);
		}

		const reqOrigin = getRequestOrigin(req);
		let redirectOrigin = '';
		try {
			redirectOrigin = new URL(resolvedRedirectUri).origin;
		} catch {
			redirectOrigin = '';
		}
		const isCrossHost = Boolean(reqOrigin && redirectOrigin && reqOrigin !== redirectOrigin);

		let state;
		if (isCrossHost) {
			// Local dev workaround: callback host differs (e.g. shop.localhost -> localhost).
			// Sessions cannot be shared across these hosts, so we bridge via an in-memory one-time ticket.
			state = shopOAuthBridge.createState({ nextUrl, shopOrigin: reqOrigin });
		} else {
			state = crypto.randomBytes(16).toString('hex');
			if (req.session) {
				req.session.shopGoogleOAuthState = state;
				req.session.shopGoogleOAuthNext = nextUrl;
			}
		}
		const url = await googleShopAuth.getAuthUrl(req, { state });
		if (!url) {
			return res.redirect(`/login?error=1&next=${encodeURIComponent(nextUrl)}`);
		}
		return res.redirect(url);
	} catch (err) {
		next(err);
	}
}

async function finishGoogleLogin(req, res, next) {
	try {
		const code = String(req.query.code || '').trim();
		const state = String(req.query.state || '').trim();
		const expectedState = req.session ? String(req.session.shopGoogleOAuthState || '') : '';
		const nextUrl = req.session ? String(req.session.shopGoogleOAuthNext || '').trim() : '';

		if (!code) return res.status(400).redirect('/login?error=1');

		const sessionStateOk = Boolean(state && expectedState && state === expectedState);
		const bridgedState = sessionStateOk ? null : shopOAuthBridge.consumeState(state);
		if (!sessionStateOk && !bridgedState) {
			return res.status(401).redirect('/login?error=1');
		}

		// one-time use (session-based flow)
		if (sessionStateOk) {
			try {
				delete req.session.shopGoogleOAuthState;
				delete req.session.shopGoogleOAuthNext;
			} catch {
				// ignore
			}
		}

		const profile = await googleShopAuth.exchangeCodeForProfile(req, code);
		const user = await userModel.upsertGoogleUser({
			email: profile.email,
			fullName: profile.fullName,
			googleSub: profile.googleSub,
		});

		// If OAuth state was bridged (cross-host local dev), finalize on the original shop host
		// so the session cookie is set on the correct hostname.
		if (bridgedState && bridgedState.shopOrigin) {
			const ticket = shopOAuthBridge.createTicket({ userId: user.id, nextUrl: bridgedState.nextUrl || '/' });
			return res.redirect(`${bridgedState.shopOrigin}/auth/google/complete?ticket=${encodeURIComponent(ticket)}`);
		}

		// Session regeneration for security (prevent session fixation)
		const sessionCartItems = req.session && req.session.cart && Array.isArray(req.session.cart.items)
			? [...req.session.cart.items]
			: [];
		
		await new Promise((resolve) => {
			req.session.regenerate((err) => {
				if (err) {
					logger.warn('[auth] session regenerate failed on Google login', { message: err?.message });
				}
				resolve();
			});
		});
		
		req.session.userId = user.id;

		// Merge guest session cart into DB cart
		try {
			await cartModel.mergeSessionCartIntoUserCart({ userId: user.id, sessionCartItems: sessionCartItems });
			if (req.session) req.session.cart = { items: [] };
		} catch {
			// best-effort
		}

		return res.redirect(nextUrl || '/');
	} catch (err) {
		next(err);
	}
}

async function completeGoogleLogin(req, res, next) {
	try {
		const ticket = String(req.query.ticket || '').trim();
		const payload = shopOAuthBridge.consumeTicket(ticket);
		if (!payload || !payload.userId) {
			return res.redirect('/login?error=1');
		}

		req.session.userId = payload.userId;

		// Merge guest session cart (on the shop host) into DB cart
		try {
			const sessionItems = req.session && req.session.cart && Array.isArray(req.session.cart.items)
				? req.session.cart.items
				: [];
			await cartModel.mergeSessionCartIntoUserCart({ userId: payload.userId, sessionCartItems: sessionItems });
			if (req.session) req.session.cart = { items: [] };
		} catch {
			// best-effort
		}

		return res.redirect(payload.nextUrl || '/');
	} catch (err) {
		next(err);
	}
}

async function logout(req, res) {
	try {
		// Shop logout should not destroy entire session (admin may share cookie in dev)
		try { delete req.session.userId; } catch { /* ignore */ }
		res.redirect('/');
	} catch {
		res.redirect('/');
	}
}

module.exports = {
	// Admin auth
	renderLogin,
	adminLogin,
	adminLogout,

	// Shop customer auth
	renderShopLogin,
	renderShopRegister,
	renderForgotPassword,
	forgotPassword,
	renderResetPassword,
	resetPassword,
	login,
	register,
	logout,

	// Shop Google OAuth
	beginGoogleLogin,
	finishGoogleLogin,
	completeGoogleLogin,
};
