const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool } = require('./config/db');
const { logger } = require('./config/logger');
const { apiLimiter } = require('./middleware/rateLimiter');
const { detectAdminContext, computeAdminRouting } = require('./middleware/adminContext');
const { notFoundHandler, errorHandler } = require('./middleware/errors');
const { createSettingsLocalsMiddleware } = require('./middleware/settingsLocals');
const { parseAppBaseUrls, getPrimaryConfiguredBaseUrl } = require('./utils/appBaseUrl');
const {
	paymentStatusLabelTR,
	orderStageLabelTR,
	orderStatusLabelTR,
	cancellationRequestTextTR,
	cancellationRequestBadgeTR,
	isPaidPaymentStatus,
} = require('./utils/statusLabels');

const publicRouter = require('./routes/publicRoutes');
const bookingRouter = require('./routes/bookingRoutes');
const adminRouter = require('./routes/adminRoutes');
const adminApiRouter = require('./routes/adminApiRoutes');
const shopRouter = require('./routes/shopRoutes');
const shopAdminRouter = require('./routes/shopAdminRoutes');
const shopController = require('./controllers/shopController');

const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const allowUnsafeInlineScripts = !isProduction || process.env.CSP_ALLOW_UNSAFE_INLINE === '1';

const paymentCallbackPaths = new Set(['/payment-callback', '/shop/payment-callback']);
const isPaymentCallbackRequest = (req) => paymentCallbackPaths.has(req.path);

app.disable('x-powered-by');

if (process.env.NODE_ENV === 'production') {
	// Needed for secure cookies behind a reverse proxy (e.g., Nginx).
	app.set('trust proxy', 1);
}

// Ignore favicon.ico
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Shared helpers for EJS templates (shop + shopadmin + admin/public).
app.locals.paymentStatusLabelTR = paymentStatusLabelTR;
app.locals.orderStageLabelTR = orderStageLabelTR;
app.locals.orderStatusLabelTR = orderStatusLabelTR;
app.locals.cancellationRequestTextTR = cancellationRequestTextTR;
app.locals.cancellationRequestBadgeTR = cancellationRequestBadgeTR;
app.locals.isPaidPaymentStatus = isPaidPaymentStatus;

app.use((req, res, next) => {
	res.locals.paymentStatusLabelTR = paymentStatusLabelTR;
	res.locals.orderStageLabelTR = orderStageLabelTR;
	res.locals.orderStatusLabelTR = orderStatusLabelTR;
	res.locals.cancellationRequestTextTR = cancellationRequestTextTR;
	res.locals.cancellationRequestBadgeTR = cancellationRequestBadgeTR;
	res.locals.isPaidPaymentStatus = isPaidPaymentStatus;
	next();
});

app.use(
	helmet({
		contentSecurityPolicy: {
			useDefaults: true,
			directives: {
				defaultSrc: ["'self'"],
				baseUri: ["'self'"],
				objectSrc: ["'none'"],
				// Iyzipay checkout embeds a form that posts to Iyzipay sandbox/prod APIs.
				// Without this, Helmet defaults to form-action 'self' and blocks checkout.
				formAction: ["'self'", 'https://*.iyzipay.com'],
				// Allow frame ancestors for Iyzico 3D Secure callbacks (iframe mode)
				frameAncestors: ["'self'", 'https://*.iyzipay.com'],
				// Iyzipay checkout loads images/fonts from its own CDN(s).
				imgSrc: ["'self'", 'data:', 'https://*.iyzipay.com'],
				fontSrc: ["'self'", 'data:', 'https://*.iyzipay.com'],
				connectSrc: [
					"'self'",
					'ws:',
					'wss:',
					'https://cdn.jsdelivr.net',
					'https://unpkg.com',
					// Cloudflare Web Analytics / Insights (if enabled upstream)
					'https://cloudflareinsights.com',
					'https://static.cloudflareinsights.com',
					// Iyzipay/Iyzico telemetry endpoints used by the embedded checkout.
					'https://countly.iyzico.com',
					// Some Iyzipay resources report errors to Sentry (browser-side) during checkout.
					// Keep this narrow; extend via env only if needed.
					'https://o120955.ingest.sentry.io',
					// Iyzipay checkout resources
					'https://*.iyzipay.com',
				],
				// Iyzipay checkout form is rendered via iframe/scripts.
				// Keep it narrow to iyzipay domains.
				frameSrc: [
					"'self'",
					'https://www.google.com',
					'https://www.google.com.tr',
					'https://www.google.com/maps',
					'https://maps.google.com',
					'https://*.iyzipay.com',
				],
				scriptSrc: [
					"'self'",
					'https://cdn.jsdelivr.net',
					'https://unpkg.com',
					'https://*.iyzipay.com',
					// Cloudflare Web Analytics / Insights (if enabled upstream)
					'https://static.cloudflareinsights.com',
					...(allowUnsafeInlineScripts ? ["'unsafe-inline'"] : []),
				],
				scriptSrcElem: [
					"'self'",
					'https://cdn.jsdelivr.net',
					'https://unpkg.com',
					'https://*.iyzipay.com',
					'https://static.cloudflareinsights.com',
					...(allowUnsafeInlineScripts ? ["'unsafe-inline'"] : []),
				],
				styleSrc: ["'self'", "'unsafe-inline'"],
			},
		},
	})
);

// CORS - Production'da sadece belirlenen domainlere izin ver
if (process.env.CORS_ORIGIN) {
	const origins = process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
	const appBaseUrl = getPrimaryConfiguredBaseUrl() || (parseAppBaseUrls(process.env.APP_BASE_URL)[0] || '');
	let appBase;
	try {
		appBase = appBaseUrl ? new URL(appBaseUrl) : null;
	} catch {
		appBase = null;
	}
	const baseHostname = appBase ? String(appBase.hostname || '').toLowerCase() : '';
	const baseProtocol = appBase ? String(appBase.protocol || '').toLowerCase() : '';
	app.use(
		cors({
			origin: (origin, callback) => {
				// API çağrılarında origin kontrolü
				// origin === 'null' kontrolü eklendi (bazı tarayıcılar/durumlar için)
				if (!origin || origins.includes(origin) || origin === 'null') {
					callback(null, true);
					return;
				}

				// If APP_BASE_URL is set in production, allow same base-domain subdomains over the same protocol.
				// Example: APP_BASE_URL=https://demoishsite.com allows https://admin.demoishsite.com, https://shop.demoishsite.com, etc.
				if (isProduction && baseHostname && baseProtocol && origin) {
					try {
						const o = new URL(origin);
						const oHost = String(o.hostname || '').toLowerCase();
						const oProto = String(o.protocol || '').toLowerCase();
						if (
							oProto === baseProtocol
							&& (oHost === baseHostname || oHost.endsWith(`.${baseHostname}`))
						) {
							callback(null, true);
							return;
						}
					} catch {
						// ignore parse errors
					}
				} else {
					logger.warn(`CORS blocked request from origin: ${origin}`);
					callback(new Error('CORS policy: Origin not allowed'));
				}
			},
			credentials: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE'],
			allowedHeaders: ['Content-Type', 'Authorization'],
			maxAge: 600, // 10 dakika
		})
	);
} else if (isProduction) {
	// Production'da CORS_ORIGIN tanımlanmadıysa sıkı mod
	app.use(
		cors({
			origin: false, // Tüm cross-origin istekleri reddet
		})
	);
}

// Morgan - Winston ile entegrasyon
app.use(	morgan(':method :url :status :response-time ms', {
		stream: {
			write: (message) => {
				logger.info(message.trim());
			},
		},
	})
);

// API rate limiting - Tüm API route'larına genel limit
app.use('/api', apiLimiter);

// Payment callbacks must be reachable and fast. Handle them BEFORE body parsers so that
// we can respond immediately even if the provider sends a slow/odd POST body.
// These handlers are stateless (session is skipped below) and internally verify token/order.
app.post('/payment-callback', shopController.paymentCallback);
app.get('/payment-callback', shopController.paymentCallbackGet);
app.post('/shop/payment-callback', shopController.paymentCallback);
app.get('/shop/payment-callback', shopController.paymentCallbackGet);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global company/legal settings for EJS: res.locals.settings.*
app.use(createSettingsLocalsMiddleware({ ttlMs: 60_000 }));

const sessionMiddleware = session({
	store: new pgSession({
		pool,
		tableName: 'sessions',
	}),
	secret: (() => {
		if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
			throw new Error('SESSION_SECRET is required in production');
		}
		return process.env.SESSION_SECRET || 'change-me';
	})(),
	resave: false,
	saveUninitialized: false,
	cookie: {
		httpOnly: true,
		sameSite: isProduction ? 'none' : 'lax',
		// Production: secure cookies are required when SameSite=None.
		secure: isProduction,
		maxAge: 1000 * 60 * 60 * 8,
	},
});

app.use((req, res, next) => {
	// Iyzipay can call these endpoints from within an iframe after 3DS.
	// Keep them stateless and fast: avoid session store round-trips/timeouts.
	if (isPaymentCallbackRequest(req)) return next();
	return sessionMiddleware(req, res, next);
});

// Optional CSRF protection: enable with CSRF_ENABLED=1 if you have CSRF tokens wired in forms.
// Always exclude payment callback endpoints (Iyzipay doesn't send CSRF tokens).
if (process.env.CSRF_ENABLED === '1') {
	let csrfProtection = null;
	try {
		const csurf = require('csurf');
		csrfProtection = csurf();
	} catch (err) {
		logger.warn('CSRF middleware requested but csurf is not installed.', { message: err?.message });
		csrfProtection = null;
	}

	if (csrfProtection) {
		app.use((req, res, next) => {
			if (isPaymentCallbackRequest(req)) return next();
			return csrfProtection(req, res, next);
		});
	}
}

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

app.use(detectAdminContext());

// Admin routing behavior:
// - Production domain: admin lives at https://admin.<domain>/ (no /admin prefix)
// - /admin is disabled everywhere; use the admin subdomain only
app.use((req, res, next) => {
	const ctx = computeAdminRouting(req);
	const adminPathPrefix = ctx.adminPathPrefix || '/admin';

	// Legacy /admin URLs on admin subdomain should redirect to root paths.
	if (ctx.subdomainRoot && adminPathPrefix && (req.path === adminPathPrefix || req.path.startsWith(`${adminPathPrefix}/`))) {
		const stripped = req.originalUrl.replace(new RegExp(`^${adminPathPrefix}`), '') || '/';
		return res.redirect(302, stripped);
	}

	// Disable /admin on non-admin hosts.
	if (!ctx.isAdminHost && adminPathPrefix && (req.path === adminPathPrefix || req.path.startsWith(`${adminPathPrefix}/`))) {
		const hostname = String(req.hostname || '').toLowerCase();
		const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
		const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
		const isShopHost = Boolean(shopPrefix && hostname.startsWith(shopPrefix));
		const isShopAdminHost = Boolean(shopAdminPrefix && hostname.startsWith(shopAdminPrefix));
		return res.status(404).render('pages/404', {
			title: 'Sayfa Bulunamadı',
			...(isShopAdminHost ? { layout: 'layouts/shopAdmin' } : {}),
			...(isShopHost ? { layout: 'layouts/shop' } : {}),
		});
	}

	return next();
});

// Admin routes (conditional mount)
app.use((req, res, next) => {
	const ctx = computeAdminRouting(req);
	if (ctx.subdomainRoot) return adminRouter(req, res, next);
	return next();
});

app.use('/api', (req, res, next) => {
	const ctx = computeAdminRouting(req);
	if (ctx.subdomainRoot) return adminApiRouter(req, res, next);
	return res.status(404).json({ ok: false, message: 'Not found' });
});

// Public routes (do not serve public site on admin subdomain)
app.use((req, res, next) => {
	const ctx = computeAdminRouting(req);
	if (ctx.subdomainRoot) return res.status(404).render('admin/404', { title: 'Sayfa Bulunamadı', layout: 'layouts/admin' });
	return next();
});

// Shop routing behavior:
// - shop.<domain> (or shop.localhost): shop lives at root
// - shopadmin.<domain> (or shopadmin.localhost): shop admin lives at root
// - main domain: existing public routes keep working
app.use((req, res, next) => {
	const adminCtx = computeAdminRouting(req);
	// Never interfere with existing admin host behavior.
	if (adminCtx.isAdminHost) return next();

	const hostname = String(req.hostname || '').toLowerCase();
	const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
	const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
	const allowShopOnLocalhost = process.env.SHOP_ALLOW_LOCALHOST === '1';

	const isLocalShopHost = Boolean(
		allowShopOnLocalhost
			&& adminCtx.isLocalhost
			&& (hostname === 'localhost' || hostname === '127.0.0.1')
	);

	const isShopOAuthPath = req.path === '/auth/google' || req.path === '/auth/google/callback';
	let allowShopOAuthOnLocalhost = false;
	if (adminCtx.isLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1') && isShopOAuthPath) {
		try {
			const configured = String(process.env.SHOP_GOOGLE_REDIRECT_URIS || process.env.SHOP_GOOGLE_REDIRECT_URI || '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			allowShopOAuthOnLocalhost = configured.some((u) => {
				try {
					const parsed = new URL(u);
					const hostOk = String(parsed.hostname || '').toLowerCase() === hostname;
					const pathOk = String(parsed.pathname || '') === '/auth/google/callback';
					return hostOk && pathOk;
				} catch {
					return false;
				}
			});
		} catch {
			allowShopOAuthOnLocalhost = false;
		}
	}

	const isShopHost = Boolean((shopPrefix && hostname.startsWith(shopPrefix)) || isLocalShopHost || allowShopOAuthOnLocalhost);
	const isShopAdminHost = Boolean(shopAdminPrefix && hostname.startsWith(shopAdminPrefix));

	req.isShopHost = isShopHost;
	req.isShopAdminHost = isShopAdminHost;
	res.locals.isShopHost = isShopHost;
	res.locals.isShopAdminHost = isShopAdminHost;

	if (isShopAdminHost) {
		// Reuse the existing admin layout styles, but avoid admin-base-path redirects.
		req.adminBasePath = '';
		req.adminApiBasePath = '/api';
		res.locals.adminBasePath = '';
		res.locals.adminApiBasePath = '/api';
		return shopAdminRouter(req, res, next);
	}

	if (isShopHost) {
		return shopRouter(req, res, next);
	}

	return next();
});

app.use('/', publicRouter);
app.use('/booking', bookingRouter);

// Shop-specific booking APIs (forces category server-side)
app.use(
	'/berber/booking',
	(req, _res, next) => {
		req.query.category = 'men';
		if (req.method === 'POST' && req.body && typeof req.body === 'object') req.body.category = 'men';
		next();
	},
	bookingRouter
);
app.use(
	'/guzellik/booking',
	(req, _res, next) => {
		req.query.category = 'women';
		if (req.method === 'POST' && req.body && typeof req.body === 'object') req.body.category = 'women';
		next();
	},
	bookingRouter
);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
