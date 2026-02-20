/**
 * Google reCAPTCHA v3 middleware
 * Protects forms from bot submissions
 */

const { logger } = require('../config/logger');

const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;
const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY;
const RECAPTCHA_MIN_SCORE = Number(process.env.RECAPTCHA_MIN_SCORE) || 0.5;
const RECAPTCHA_ENABLED = process.env.RECAPTCHA_ENABLED === '1';

/**
 * Verify reCAPTCHA token with Google
 * @param {string} token - reCAPTCHA response token
 * @param {string} remoteIp - Client IP address
 * @returns {Promise<{success: boolean, score?: number, action?: string, error?: string}>}
 */
async function verifyToken(token, remoteIp) {
	if (!token) {
		return { success: false, error: 'missing_token' };
	}

	if (!RECAPTCHA_SECRET_KEY) {
		logger.warn('[recaptcha] RECAPTCHA_SECRET_KEY not configured');
		return { success: true, score: 1.0 }; // Allow if not configured
	}

	try {
		const params = new URLSearchParams({
			secret: RECAPTCHA_SECRET_KEY,
			response: token,
			...(remoteIp ? { remoteip: remoteIp } : {}),
		});

		const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: params.toString(),
		});

		const data = await response.json();

		if (!data.success) {
			return {
				success: false,
				error: Array.isArray(data['error-codes']) ? data['error-codes'].join(', ') : 'verification_failed',
			};
		}

		return {
			success: true,
			score: data.score,
			action: data.action,
			hostname: data.hostname,
		};
	} catch (err) {
		logger.error('[recaptcha] verification failed', { message: err?.message });
		return { success: false, error: 'network_error' };
	}
}

/**
 * reCAPTCHA middleware factory
 * @param {Object} options - Configuration options
 * @param {string} options.action - Expected action name
 * @param {number} options.minScore - Minimum score to pass (default: 0.5)
 * @param {boolean} options.optional - If true, allow request even if reCAPTCHA fails
 * @returns {Function} Express middleware
 */
function recaptchaMiddleware(options = {}) {
	const { action, minScore = RECAPTCHA_MIN_SCORE, optional = false } = options;

	return async (req, res, next) => {
		// Skip if reCAPTCHA is not enabled
		if (!RECAPTCHA_ENABLED) {
			return next();
		}

		// Get token from body or header
		const token = req.body?.recaptchaToken 
			|| req.body?.['g-recaptcha-response']
			|| req.headers['x-recaptcha-token'];

		if (!token) {
			if (optional) {
				req.recaptcha = { verified: false, reason: 'no_token' };
				return next();
			}
			return res.status(400).json({ 
				error: 'reCAPTCHA doğrulaması gerekli.',
				code: 'RECAPTCHA_REQUIRED',
			});
		}

		// Get client IP
		const remoteIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

		const result = await verifyToken(token, remoteIp);

		if (!result.success) {
			logger.warn('[recaptcha] verification failed', { 
				action: action || 'unknown',
				error: result.error,
				ip: remoteIp,
			});

			if (optional) {
				req.recaptcha = { verified: false, reason: result.error };
				return next();
			}

			return res.status(400).json({
				error: 'reCAPTCHA doğrulaması başarısız. Lütfen tekrar deneyin.',
				code: 'RECAPTCHA_FAILED',
			});
		}

		// Check score
		if (result.score !== undefined && result.score < minScore) {
			logger.warn('[recaptcha] low score', { 
				action: action || 'unknown',
				score: result.score,
				minScore,
				ip: remoteIp,
			});

			if (optional) {
				req.recaptcha = { verified: false, reason: 'low_score', score: result.score };
				return next();
			}

			return res.status(400).json({
				error: 'Güvenlik doğrulaması başarısız. Lütfen tekrar deneyin.',
				code: 'RECAPTCHA_LOW_SCORE',
			});
		}

		// Check action if specified
		if (action && result.action && result.action !== action) {
			logger.warn('[recaptcha] action mismatch', { 
				expected: action,
				received: result.action,
				ip: remoteIp,
			});
			// Don't block on action mismatch, just log
		}

		req.recaptcha = { 
			verified: true, 
			score: result.score,
			action: result.action,
		};

		next();
	};
}

/**
 * Get reCAPTCHA site key for frontend
 */
function getSiteKey() {
	return RECAPTCHA_SITE_KEY || '';
}

/**
 * Check if reCAPTCHA is enabled
 */
function isEnabled() {
	return RECAPTCHA_ENABLED && !!RECAPTCHA_SECRET_KEY && !!RECAPTCHA_SITE_KEY;
}

module.exports = {
	recaptchaMiddleware,
	verifyToken,
	getSiteKey,
	isEnabled,
};
