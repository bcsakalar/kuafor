const https = require('https');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { logger } = require('../config/logger');
const {
	getBrevoApiKey,
	getDefaultSender,
	getSenderEmailFromEnv,
} = require('../config/email');
const { parseAppBaseUrls, getPrimaryConfiguredBaseUrl } = require('../utils/appBaseUrl');
const {
	paymentStatusLabelTR,
	orderStageLabelTR,
	orderStatusLabelTR,
	cancellationRequestTextTR,
	cancellationRequestBadgeTR,
	isPaidPaymentStatus,
} = require('../utils/statusLabels');

function normalizeChannel(channel) {
	const c = String(channel || 'default').trim().toLowerCase();
	return c === 'booking' || c === 'shop' ? c : 'default';
}

const EMAIL_TEMPLATES_DIR = path.join(__dirname, '..', 'views', 'emails');

let cachedInlineLogoDataUri = null;

function detectImageMime(buf) {
	if (!buf || buf.length < 8) return 'application/octet-stream';
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		buf[0] === 0x89
		&& buf[1] === 0x50
		&& buf[2] === 0x4e
		&& buf[3] === 0x47
		&& buf[4] === 0x0d
		&& buf[5] === 0x0a
		&& buf[6] === 0x1a
		&& buf[7] === 0x0a
	) return 'image/png';
	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
	// GIF: GIF87a / GIF89a
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
	return 'application/octet-stream';
}

function getInlineLogoDataUri() {
	if (cachedInlineLogoDataUri) return cachedInlineLogoDataUri;
	try {
		const logoPath = path.join(__dirname, '..', '..', 'public', 'logo', 'logo.jpg');
		const buf = fs.readFileSync(logoPath);
		const mime = detectImageMime(buf);
		cachedInlineLogoDataUri = `data:${mime};base64,${buf.toString('base64')}`;
		return cachedInlineLogoDataUri;
	} catch (err) {
		logger.warn('[email] inline logo read failed; falling back to absolute URL', {
			message: err?.message,
		});
		cachedInlineLogoDataUri = '';
		return '';
	}
}

function assertBrevoConfigured() {
	const apiKey = getBrevoApiKey();
	const sender = getDefaultSender();
	if (!apiKey) {
		const err = new Error('Brevo API key missing (BREVO_API_KEY)');
		err.code = 'EMAIL_NOT_CONFIGURED';
		throw err;
	}
	if (!sender?.email) {
		const err = new Error('Email sender missing (EMAIL_FROM_EMAIL)');
		err.code = 'EMAIL_NOT_CONFIGURED';
		throw err;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function brevoRequestJson({ method, path, body }) {
	const apiKey = getBrevoApiKey();
	const payload = body ? JSON.stringify(body) : '';

	const options = {
		hostname: 'api.brevo.com',
		port: 443,
		path,
		method,
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'api-key': apiKey,
			...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
		},
	};

	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			let raw = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => {
				raw += chunk;
			});
			res.on('end', () => {
				const status = res.statusCode || 0;
				let json = null;
				try {
					json = raw ? JSON.parse(raw) : null;
				} catch {
					json = null;
				}
				resolve({ status, json, raw });
			});
		});

		req.on('error', reject);
		if (payload) req.write(payload);
		req.end();
	});
}

async function sendEmail(to, subject, htmlContent, opts = {}) {
	const channel = normalizeChannel(opts && typeof opts === 'object' ? opts.channel : 'default');
	try {
		assertBrevoConfigured();

		const safeTo = String(to || '').trim();
		const safeSubject = String(subject || '').trim();
		const safeHtml = String(htmlContent || '');
		const sender = getSenderEmailFromEnv(opts);
		const safeReplyTo = String((opts && opts.replyTo) || '').trim();

		if (!safeTo) {
			const err = new Error('Missing "to" address');
			err.code = 'EMAIL_INVALID_TO';
			throw err;
		}
		if (!safeSubject) {
			const err = new Error('Missing email subject');
			err.code = 'EMAIL_INVALID_SUBJECT';
			throw err;
		}

		const requestBody = {
			sender: {
				email: String(sender.email || '').trim(),
				...(sender.name ? { name: String(sender.name) } : {}),
			},
			to: [{ email: safeTo }],
			subject: safeSubject,
			htmlContent: safeHtml,
			...(safeReplyTo ? { replyTo: { email: safeReplyTo } } : {}),
		};

		// Ekler: opts.attachments = [{ content: Buffer, name: 'dosya.pdf' }] → Brevo base64 + name
		const attachments = opts && Array.isArray(opts.attachments) ? opts.attachments : [];
		if (attachments.length > 0) {
			requestBody.attachment = attachments
				.filter((a) => a && (Buffer.isBuffer(a.content) || typeof a.content === 'string') && a.name)
				.map((a) => ({
					name: String(a.name).trim().slice(0, 255),
					content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : String(a.content),
				}));
		}

		// Retry once for transient Brevo/API gateway errors.
		const maxAttempts = 2;
		let last = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const res = await brevoRequestJson({ method: 'POST', path: '/v3/smtp/email', body: requestBody });
			last = res;
			if (res.status >= 200 && res.status < 300) {
				return {
					provider: 'brevo',
					channel,
					messageId: res.json?.messageId || null,
					messageIds: res.json?.messageIds || null,
				};
			}

			const isRetriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
			if (!isRetriable || attempt === maxAttempts) break;
			await sleep(400 * attempt);
		}

		const err = new Error(`Brevo API error (status=${last?.status || 0})`);
		err.code = 'EMAIL_PROVIDER_ERROR';
		err.status = last?.status || 0;
		err.providerResponse = last?.json || last?.raw || null;
		throw err;
	} catch (err) {
		logger.error('[email] sendEmail failed', {
			message: err?.message,
			code: err?.code,
			channel,
			to,
			subject,
			status: err?.status || null,
			providerResponse: err?.providerResponse || null,
			stack: err?.stack,
		});
		throw err;
	}
}

async function getTemplate(templateName, data) {
	try {
		const safeName = String(templateName || '').trim();
		if (!safeName) {
			const err = new Error('Missing templateName');
			err.code = 'EMAIL_TEMPLATE_NAME_MISSING';
			throw err;
		}

		// Prevent path traversal and keep template naming predictable.
		// Allow nested templates like "shop/order-confirmation".
		// Disallow backslashes and any dot-segments.
		if (!/^[a-z0-9][a-z0-9-_]*(\/[a-z0-9][a-z0-9-_]*)*(\\.ejs)?$/i.test(safeName)) {
			const err = new Error('Invalid templateName');
			err.code = 'EMAIL_TEMPLATE_NAME_INVALID';
			throw err;
		}

		const filename = safeName.toLowerCase().endsWith('.ejs') ? safeName : `${safeName}.ejs`;
		const templatePath = path.join(EMAIL_TEMPLATES_DIR, filename);
		// Ensure final resolved path stays within EMAIL_TEMPLATES_DIR
		const resolvedBase = path.resolve(EMAIL_TEMPLATES_DIR);
		const resolvedTarget = path.resolve(templatePath);
		if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
			const err = new Error('Invalid template path');
			err.code = 'EMAIL_TEMPLATE_PATH_INVALID';
			throw err;
		}
		const brandName = String(process.env.SITE_BRAND_NAME || process.env.EMAIL_FROM_NAME || 'BySamet Erkek Kuaförü').trim() || 'BySamet Erkek Kuaförü';
		const templateData = {
			appBaseUrl: (getPrimaryConfiguredBaseUrl() || parseAppBaseUrls(process.env.APP_BASE_URL)[0] || ''),
			brandName,
			year: new Date().getFullYear(),
			paymentStatusLabelTR,
			orderStageLabelTR,
			orderStatusLabelTR,
			cancellationRequestTextTR,
			cancellationRequestBadgeTR,
			isPaidPaymentStatus,
			...(data && typeof data === 'object' ? data : {}),
		};

		let html = await new Promise((resolve, reject) => {
			ejs.renderFile(
				templatePath,
				templateData,
				{ async: true },
				(err, str) => {
					if (err) return reject(err);
					return resolve(str);
				}
			);
		});

		// Gmail 102KB limiti için: gereksiz boşluk/newline azalt (layout bozulmasın)
		html = String(html || '')
			.replace(/>\s+</g, '> <')
			.replace(/\s{2,}/g, ' ');

		return html;
	} catch (err) {
		logger.error('[email] getTemplate failed', {
			message: err?.message,
			code: err?.code,
			templateName,
			stack: err?.stack,
		});
		throw err;
	}
}

module.exports = { sendEmail, getTemplate };
