const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { pool } = require('../config/db');
const { logger } = require('../config/logger');
const { parseAppBaseUrls, getPrimaryConfiguredBaseUrl } = require('../utils/appBaseUrl');

let io;

let sessionMiddleware;

function isUuid(v) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}

function normalizeTrackingCode(value) {
	const raw = String(value || '').trim().toUpperCase();
	if (!raw) return '';
	let compact = raw.replace(/[^A-Z0-9]/g, '');
	if (compact.startsWith('TRK')) compact = compact.slice(3);
	if (compact.length !== 12) return '';
	return `TRK-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

function getSessionMiddleware() {
	if (sessionMiddleware) return sessionMiddleware;

	sessionMiddleware = session({
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
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
			maxAge: 1000 * 60 * 60 * 8,
		},
	});

	return sessionMiddleware;
}

function buildCorsOptions() {
	const isProduction = process.env.NODE_ENV === 'production';
	const corsOriginRaw = String(process.env.CORS_ORIGIN || '').trim();
	const origins = corsOriginRaw
		? corsOriginRaw.split(',').map((s) => s.trim()).filter(Boolean)
		: [];

	const appBaseUrl = getPrimaryConfiguredBaseUrl() || (parseAppBaseUrls(process.env.APP_BASE_URL)[0] || '');
	let appBase;
	try {
		appBase = appBaseUrl ? new URL(appBaseUrl) : null;
	} catch {
		appBase = null;
	}

	const baseHostname = appBase ? String(appBase.hostname || '').toLowerCase() : '';
	const baseProtocol = appBase ? String(appBase.protocol || '').toLowerCase() : '';

	function isBaseDomainAllowed(origin) {
		if (!isProduction || !baseHostname || !baseProtocol || !origin) return false;
		try {
			const o = new URL(origin);
			const oHost = String(o.hostname || '').toLowerCase();
			const oProto = String(o.protocol || '').toLowerCase();
			return (
				oProto === baseProtocol
				&& (oHost === baseHostname || oHost.endsWith(`.${baseHostname}`))
			);
		} catch {
			return false;
		}
	}

	// Match app.js behavior:
	// - If CORS_ORIGIN is set: allow listed origins (+ 'null' / missing origin)
	// - In production: optionally allow same base-domain subdomains when APP_BASE_URL is set
	// - Otherwise (dev): allow all
	if (origins.length > 0) {
		return {
			origin: (origin, callback) => {
				if (!origin || origin === 'null' || origins.includes(origin)) {
					callback(null, true);
					return;
				}

				if (isBaseDomainAllowed(origin)) {
					callback(null, true);
					return;
				}

				callback(new Error('CORS policy: Origin not allowed'));
			},
			credentials: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE'],
		};
	}

	if (isProduction) {
		// Production strict mode:
		// - If APP_BASE_URL is set: allow base-domain subdomains over same protocol
		// - Otherwise: allowRequest() will allow same-origin; we keep CORS strict here
		return {
			origin: (origin, callback) => {
				if (!origin || origin === 'null') {
					callback(null, true);
					return;
				}
				if (isBaseDomainAllowed(origin)) {
					callback(null, true);
					return;
				}
				callback(new Error('CORS policy: Origin not allowed'));
			},
			credentials: true,
			methods: ['GET', 'POST', 'PUT', 'DELETE'],
		};
	}

	return {
		origin: true,
		credentials: true,
		methods: ['GET', 'POST', 'PUT', 'DELETE'],
	};
}

function init(server) {
	if (io) return io;
	if (!server) throw new Error('[socketService] init(server) requires an HTTP server instance');

	const isProduction = process.env.NODE_ENV === 'production';
	const corsOriginRaw = String(process.env.CORS_ORIGIN || '').trim();
	const origins = corsOriginRaw
		? corsOriginRaw.split(',').map((s) => s.trim()).filter(Boolean)
		: [];

	const appBaseUrl = parseAppBaseUrls(process.env.APP_BASE_URL)[0] || '';
	let appBase;
	try {
		appBase = appBaseUrl ? new URL(appBaseUrl) : null;
	} catch {
		appBase = null;
	}
	const baseHostname = appBase ? String(appBase.hostname || '').toLowerCase() : '';
	const baseProtocol = appBase ? String(appBase.protocol || '').toLowerCase() : '';

	function isBaseDomainAllowed(origin) {
		if (!isProduction || !baseHostname || !baseProtocol || !origin) return false;
		try {
			const o = new URL(origin);
			const oHost = String(o.hostname || '').toLowerCase();
			const oProto = String(o.protocol || '').toLowerCase();
			return (
				oProto === baseProtocol
				&& (oHost === baseHostname || oHost.endsWith(`.${baseHostname}`))
			);
		} catch {
			return false;
		}
	}

	io = new Server(server, {
		cors: buildCorsOptions(),
		allowRequest: (req, callback) => {
			const origin = String(req?.headers?.origin || '').trim();
			const host = String(req?.headers?.host || '').trim();

			// Non-browser / no Origin header (or explicit null): allow.
			if (!origin || origin === 'null') {
				callback(null, true);
				return;
			}

			// If explicit origins are configured, require match (or base-domain rule).
			if (origins.length > 0) {
				if (origins.includes(origin) || isBaseDomainAllowed(origin)) {
					callback(null, true);
					return;
				}
				callback('CORS policy: Origin not allowed', false);
				return;
			}

			// If APP_BASE_URL is configured in production, allow base-domain subdomains.
			if (isBaseDomainAllowed(origin)) {
				callback(null, true);
				return;
			}

			// Default: allow same-origin (Origin host must equal Host header).
			try {
				const o = new URL(origin);
				if (host && String(o.host || '') === host) {
					callback(null, true);
					return;
				}
			} catch {
				// ignore
			}

			// In development, be permissive.
			if (!isProduction) {
				callback(null, true);
				return;
			}

			callback('CORS policy: Origin not allowed', false);
		},
	});

	// Attach the same session store to Socket.IO connections so we can authorize rooms.
	io.use((socket, next) => {
		try {
			const mw = getSessionMiddleware();
			mw(socket.request, {}, next);
		} catch (err) {
			next(err);
		}
	});

	io.on('connection', (socket) => {
		logger.debug('[socket] client connected');

		// Session-backed room assignment (no client-provided room names).
		try {
			const s = socket.request && socket.request.session;
			const adminId = s && s.adminId;
			const userId = s && s.userId;
			if (adminId) socket.join('adminRoom');
			// Note: shop auth uses users.id (not customers.id). Keep legacy room name.
			if (userId) socket.join(`customer:${String(userId)}`);
		} catch {
			// ignore
		}

		// Client-driven subscriptions (validated).
		socket.on('subscribe', async (payload) => {
			try {
				const s = socket.request && socket.request.session;
				const adminId = s && s.adminId;
				const userId = s && s.userId;

				const requestedOrderId = String(payload?.orderId || '').trim();
				const requestedTracking = normalizeTrackingCode(payload?.trackingCode);

				// Tracking code is effectively an access token for the public tracking page.
				if (requestedTracking) {
					socket.join(`tracking:${requestedTracking}`);
				}

				if (requestedOrderId && isUuid(requestedOrderId)) {
					if (adminId) {
						socket.join(`order:${requestedOrderId}`);
						return;
					}

					// For authenticated shop users: allow only their own order id.
					if (userId) {
						const { rows } = await pool.query(
							`SELECT shop_user_id, tracking_code
							 FROM orders
							 WHERE id = $1
							 LIMIT 1`,
							[requestedOrderId]
						);
						const r = rows[0] || null;
						if (r && r.shop_user_id && String(r.shop_user_id) === String(userId)) {
							socket.join(`order:${requestedOrderId}`);
							const t = normalizeTrackingCode(r.tracking_code);
							if (t) socket.join(`tracking:${t}`);
						}
					}
				}
			} catch (err) {
				logger.warn('[socket] subscribe failed (continuing)', {
					message: err?.message,
					code: err?.code,
				});
			}
		});

		socket.on('disconnect', () => {
			// Keep silent; clients handle reconnection automatically.
		});
	});

	return io;
}

function getIO() {
	if (!io) {
		throw new Error('[socketService] Socket.IO not initialized. Call init(server) first.');
	}
	return io;
}

module.exports = {
	init,
	getIO,
};
