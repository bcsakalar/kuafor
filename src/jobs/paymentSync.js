const orderModel = require('../models/orderModel');
const { finalizeOrder } = require('../services/orderService');
const { checkoutFormRetrieve, paymentRetrieve } = require('../services/iyzicoPaymentService');
const { logger } = require('../config/logger');

// Retry configuration
const RETRY_CONFIG = {
	maxRetries: 3,
	baseDelayMs: 5000,
	maxDelayMs: 60000,
};

// Track retry attempts per order
const retryAttempts = new Map();

function getRetryDelay(attempt) {
	// Exponential backoff with jitter
	const delay = Math.min(
		RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt),
		RETRY_CONFIG.maxDelayMs
	);
	const jitter = delay * 0.2 * Math.random();
	return delay + jitter;
}

async function runOncePaymentSync({ sinceMinutes = 180, limit = 20 } = {}) {
	let rows = [];
	try {
		rows = await orderModel.listPendingOrdersWithToken({ sinceMinutes, limit });
	} catch (err) {
		logger.warn('[paymentSync] listPendingOrdersWithToken failed', { message: err?.message, code: err?.code });
		return { processed: 0, finalized: 0, errors: 1 };
	}

	if (!rows || rows.length === 0) {
		return { processed: 0, finalized: 0, errors: 0 };
	}

	let finalized = 0;
	let errors = 0;

	for (const r of rows) {
		const orderId = String(r?.id || '').trim();
		const token = String(r?.payment_token || '').trim();
		if (!orderId || !token) continue;
		
		// Check retry attempts
		const attempts = retryAttempts.get(orderId) || 0;
		if (attempts >= RETRY_CONFIG.maxRetries) {
			logger.warn('[paymentSync] max retries exceeded, skipping order', { orderId, attempts });
			continue;
		}

		try {
			const res = await finalizeOrder({ token });
			if (res && res.ok) {
				logger.info('[paymentSync] finalized pending order', { orderId });
				retryAttempts.delete(orderId);
				finalized++;
			} else {
				// Increment retry counter
				retryAttempts.set(orderId, attempts + 1);
				errors++;
			}
		} catch (err) {
			// Non-fatal: keep trying other orders.
			retryAttempts.set(orderId, attempts + 1);
			logger.debug?.('[paymentSync] finalize failed', { 
				orderId, 
				message: err?.message, 
				code: err?.code,
				attempt: attempts + 1,
			});
			errors++;
		}
	}

	return { processed: rows.length, finalized, errors };
}

/**
 * Reconciliation job - verifies payment status with Iyzico
 * Runs daily to catch any missed callbacks or status updates
 */
async function runPaymentReconciliation({ daysBefore = 7, limit = 50 } = {}) {
	let rows = [];
	try {
		// Get orders that might need reconciliation
		rows = await orderModel.listOrdersForReconciliation({ daysBefore, limit });
	} catch (err) {
		logger.warn('[reconciliation] listOrdersForReconciliation failed', { message: err?.message });
		return { checked: 0, updated: 0, errors: 0 };
	}

	if (!rows || rows.length === 0) {
		return { checked: 0, updated: 0, errors: 0 };
	}

	let updated = 0;
	let errors = 0;

	for (const order of rows) {
		const orderId = String(order?.id || '').trim();
		const paymentId = String(order?.payment_id || '').trim();
		const paymentToken = String(order?.payment_token || '').trim();
		const currentStatus = String(order?.payment_status || '').trim();

		if (!orderId) continue;

		try {
			let iyzicoStatus = null;

			// Try to get status from Iyzico
			if (paymentId) {
				const result = await paymentRetrieve({
					locale: 'tr',
					conversationId: `recon:${orderId}:${Date.now()}`,
					paymentId,
				});
				if (result?.status === 'success') {
					iyzicoStatus = result.paymentStatus;
				}
			} else if (paymentToken) {
				const result = await checkoutFormRetrieve({
					locale: 'tr',
					token: paymentToken,
				});
				if (result?.status === 'success') {
					iyzicoStatus = result.paymentStatus;
				}
			}

			// Check if status needs update
			if (iyzicoStatus) {
				const normalizedStatus = normalizeIyzicoStatus(iyzicoStatus);
				if (normalizedStatus && normalizedStatus !== currentStatus) {
					logger.info('[reconciliation] status mismatch found', {
						orderId,
						dbStatus: currentStatus,
						iyzicoStatus: normalizedStatus,
					});
					
					// Update the order status
					await orderModel.updatePaymentStatus({
						orderId,
						paymentStatus: normalizedStatus,
						source: 'reconciliation',
					});
					updated++;
				}
			}
		} catch (err) {
			logger.debug?.('[reconciliation] check failed', {
				orderId,
				message: err?.message,
			});
			errors++;
		}

		// Small delay between API calls to avoid rate limiting
		await new Promise(resolve => setTimeout(resolve, 500));
	}

	logger.info('[reconciliation] completed', { checked: rows.length, updated, errors });
	return { checked: rows.length, updated, errors };
}

function normalizeIyzicoStatus(status) {
	const s = String(status || '').trim().toUpperCase();
	switch (s) {
		case 'SUCCESS':
		case 'APPROVED':
			return 'paid';
		case 'FAILURE':
		case 'DECLINED':
			return 'failed';
		case 'INIT_THREEDS':
		case 'CALLBACK_THREEDS':
		case 'PENDING':
			return 'pending';
		default:
			return null;
	}
}

function startPaymentSyncJobs({ intervalMs = 60_000, sinceMinutes = 180, limit = 20 } = {}) {
	const ms = Math.max(10_000, Number(intervalMs) || 60_000);
	const cfg = { sinceMinutes, limit };

	const run = () => runOncePaymentSync(cfg);
	// Run once shortly after boot, then on interval.
	setTimeout(run, 5_000).unref?.();
	setInterval(run, ms).unref?.();
	
	logger.info('[paymentSync] job started', { intervalMs: ms, sinceMinutes, limit });
}

function startReconciliationJob({ intervalMs = 6 * 60 * 60 * 1000, daysBefore = 7, limit = 50 } = {}) {
	// Default: run every 6 hours
	const ms = Math.max(60_000, Number(intervalMs) || 6 * 60 * 60 * 1000);
	const cfg = { daysBefore, limit };

	const run = () => runPaymentReconciliation(cfg);
	// Run once 30 seconds after boot, then on interval
	setTimeout(run, 30_000).unref?.();
	setInterval(run, ms).unref?.();
	
	logger.info('[reconciliation] job started', { intervalMs: ms, daysBefore, limit });
}

// Cleanup old retry attempts periodically (every hour)
setInterval(() => {
	const now = Date.now();
	for (const [orderId, attempts] of retryAttempts.entries()) {
		// Remove entries older than 24 hours (based on retry count as proxy)
		if (attempts >= RETRY_CONFIG.maxRetries) {
			retryAttempts.delete(orderId);
		}
	}
}, 60 * 60 * 1000).unref?.();

module.exports = {
	runOncePaymentSync,
	runPaymentReconciliation,
	startPaymentSyncJobs,
	startReconciliationJob,
};
