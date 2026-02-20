const { pool } = require('../config/db');
const crypto = require('crypto');
const { notifyLowStockCrossingAdmin } = require('../services/lowStockNotifyService');
const { logger } = require('../config/logger');

const ALLOWED_ORDER_STATUSES = new Set(['pending', 'shipped', 'completed', 'cancelled']);
const ALLOWED_PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'partial_refunded', 'refunded']);

async function insertPaymentEvent(client, { orderId, status, changedByAdminId = null }) {
	// Best-effort: history should not break checkout/refund flows.
	// Important: in Postgres, a failed query aborts the whole transaction until ROLLBACK.
	// Use a SAVEPOINT to ensure any failure here doesn't poison the outer transaction.
	let hasSavepoint = false;
	try {
		await client.query('SAVEPOINT sp_order_payment_event');
		hasSavepoint = true;
	} catch {
		hasSavepoint = false;
	}

	try {
		await client.query(
			`INSERT INTO order_payment_events (order_id, status, changed_by_admin_id)
			 VALUES ($1, $2, $3)`,
			[orderId, status, changedByAdminId]
		);
	} catch {
		if (hasSavepoint) {
			try { await client.query('ROLLBACK TO SAVEPOINT sp_order_payment_event'); } catch { /* ignore */ }
		}
		return;
	} finally {
		if (hasSavepoint) {
			try { await client.query('RELEASE SAVEPOINT sp_order_payment_event'); } catch { /* ignore */ }
		}
	}
}

function generateTrackingCode() {
	// Human-friendly: TRK-XXXX-XXXX-XXXX (uppercase hex)
	const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
	return `TRK-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function normalizeTrackingCode(value) {
	const raw = String(value || '').trim().toUpperCase();
	if (!raw) return '';
	// Keep only letters/numbers so inputs like "TRK-AB12 CD34" work.
	let compact = raw.replace(/[^A-Z0-9]/g, '');
	if (compact.startsWith('TRK')) compact = compact.slice(3);
	if (compact.length !== 12) return '';
	return `TRK-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

async function listOrdersByTrackingCodes(trackingCodes) {
	const codes = Array.from(
		new Set((trackingCodes || []).map((x) => normalizeTrackingCode(x)).filter(Boolean))
	).slice(0, 20);
	if (codes.length === 0) return [];

	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.payment_status,
			o.status,
			o.created_at
		 FROM orders o
		 WHERE o.tracking_code = ANY($1::text[])
		 ORDER BY o.created_at DESC`,
		[codes]
	);
	return rows;
}

async function listOrdersByCustomerId(customerId, { limit = 50 } = {}) {
	if (!customerId) return [];
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.payment_status,
			o.status,
			o.created_at
		 FROM orders o
		 WHERE o.user_id = $1
		 ORDER BY o.created_at DESC
		 LIMIT $2`,
		[customerId, lim]
	);
	return rows;
}

async function listOrdersByShopUserId(shopUserId, { limit = 50, email = null } = {}) {
	if (!shopUserId) return [];
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const normalizedEmail = email == null ? null : String(email).trim().toLowerCase().slice(0, 200) || null;
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.payment_status,
			o.status,
			o.created_at
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 WHERE o.shop_user_id = $1
			OR (
				o.shop_user_id IS NULL
				AND $2::text IS NOT NULL
				AND LOWER(COALESCE(o.customer_email, cu.email)) = $2::text
			)
		 ORDER BY o.created_at DESC
		 LIMIT $3`,
		[shopUserId, normalizedEmail, lim]
	);
	return rows;
}

async function listPaidOrdersByShopUserId(shopUserId, { limit = 50, email = null } = {}) {
	if (!shopUserId) return [];
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const normalizedEmail = email == null ? null : String(email).trim().toLowerCase().slice(0, 200) || null;
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.payment_status,
			o.status,
			o.created_at
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 WHERE (
			o.shop_user_id = $1
			OR (
				o.shop_user_id IS NULL
				AND $2::text IS NOT NULL
				AND LOWER(COALESCE(o.customer_email, cu.email)) = $2::text
			)
		 )
		 AND o.payment_status = 'paid'
		 AND o.status IS DISTINCT FROM 'cancelled'
		 ORDER BY o.created_at DESC
		 LIMIT $3`,
		[shopUserId, normalizedEmail, lim]
	);
	return rows;
}

async function listPaidOrdersByCustomerId(customerId, { limit = 50 } = {}) {
	if (!customerId) return [];
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.payment_status,
			o.status,
			o.created_at
		 FROM orders o
		 WHERE o.user_id = $1
		 AND o.payment_status = 'paid'
		 AND o.status IS DISTINCT FROM 'cancelled'
		 ORDER BY o.created_at DESC
		 LIMIT $2`,
		[customerId, lim]
	);
	return rows;
}

async function listPendingOrdersWithToken({ limit = 20, sinceMinutes = 180 } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 20));
	const mins = Math.max(1, Math.min(7 * 24 * 60, Number(sinceMinutes) || 180));
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.payment_token,
			o.created_at
		 FROM orders o
		 WHERE o.payment_status IN ('pending', 'failed')
		 AND o.status IS DISTINCT FROM 'cancelled'
		 AND o.payment_token IS NOT NULL
		 AND btrim(o.payment_token) <> ''
		 AND o.created_at >= (NOW() - make_interval(mins => $2))
		 ORDER BY o.created_at DESC
		 LIMIT $1`,
		[lim, mins]
	);
	return rows;
}

async function setOrderPaymentItems({ orderId, paymentItems }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const items = paymentItems == null ? null : paymentItems;
	await pool.query(
		`UPDATE orders
		 SET payment_items = $2
		 WHERE id = $1`,
		[orderId, items]
	);
}

async function getOrderRefundContext(orderId) {
	if (!isUuid(orderId)) return null;
	const { rows } = await pool.query(
		`SELECT
			id,
			status,
			payment_token,
			payment_id,
			payment_status,
			total_amount,
			COALESCE(refunded_amount, 0)::numeric(12, 2) AS refunded_amount,
			COALESCE(refund_in_progress, false) AS refund_in_progress,
			payment_items
		 FROM orders
		 WHERE id = $1
		 LIMIT 1`,
		[orderId]
	);
	return rows[0] || null;
}

async function listOrderRefunds(orderId) {
	if (!isUuid(orderId)) return [];
	const { rows } = await pool.query(
		`SELECT
			id,
			order_id,
			payment_transaction_id,
			amount,
			currency,
			status,
			iyzico_refund_id,
			error_message,
			created_by_admin_id,
			created_at
		 FROM order_refunds
		 WHERE order_id = $1
		 ORDER BY created_at DESC`,
		[orderId]
	);
	return rows;
}

async function getSuccessfulRefundTotalsByTransaction(orderId) {
	if (!isUuid(orderId)) return new Map();
	const { rows } = await pool.query(
		`SELECT
			payment_transaction_id,
			COALESCE(SUM(amount), 0)::numeric(12, 2) AS refunded
		 FROM order_refunds
		 WHERE order_id = $1
		 AND status = 'success'
		 GROUP BY payment_transaction_id`,
		[orderId]
	);
	const map = new Map();
	for (const r of rows) {
		map.set(String(r.payment_transaction_id), Number(r.refunded) || 0);
	}
	return map;
}

async function beginOrderRefund(orderId) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows } = await client.query(
			`SELECT
				id,
				status,
				payment_token,
				payment_id,
				payment_status,
				total_amount,
				COALESCE(refunded_amount, 0)::numeric(12, 2) AS refunded_amount,
				COALESCE(refund_in_progress, false) AS refund_in_progress,
				payment_items
			 FROM orders
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = rows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}
		if (order.refund_in_progress === true) {
			const err = new Error('Refund already in progress');
			err.statusCode = 409;
			err.code = 'REFUND_IN_PROGRESS';
			throw err;
		}
		await client.query(
			`UPDATE orders
			 SET refund_in_progress = true
			 WHERE id = $1`,
			[orderId]
		);
		await client.query('COMMIT');
		return order;
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function finishOrderRefund({ orderId, adminId = null, refundAttempts = [] }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const admin = adminId && isUuid(adminId) ? adminId : null;
	const attempts = Array.isArray(refundAttempts) ? refundAttempts : [];

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		let successDelta = 0;
		for (const a of attempts) {
			const ptid = String(a.paymentTransactionId || '').trim();
			const amount = Number(a.amount);
			if (!ptid || !Number.isFinite(amount) || amount <= 0) continue;

			const status = String(a.status || '').trim().toLowerCase();
			const normalizedStatus = status === 'success' ? 'success' : status === 'failure' ? 'failure' : 'requested';
			const currency = String(a.currency || 'TRY').trim() || 'TRY';
			const iyzicoRefundId = a.iyzicoRefundId == null ? null : String(a.iyzicoRefundId).trim() || null;
			const errorMessage = a.errorMessage == null ? null : String(a.errorMessage).trim() || null;
			const raw = a.raw == null ? null : a.raw;

			await client.query(
				`INSERT INTO order_refunds (
					order_id,
					payment_transaction_id,
					amount,
					currency,
					status,
					iyzico_refund_id,
					error_message,
					raw_response,
					created_by_admin_id
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[orderId, ptid, amount, currency, normalizedStatus, iyzicoRefundId, errorMessage, raw, admin]
			);

			if (normalizedStatus === 'success') {
				successDelta += amount;
			}
		}

		const { rows } = await client.query(
			`UPDATE orders
			 SET refunded_amount = LEAST(total_amount, COALESCE(refunded_amount, 0) + $2),
			 	refunded_at = CASE WHEN $2 > 0 THEN now() ELSE refunded_at END,
			 	refund_in_progress = false
			 WHERE id = $1
			 RETURNING total_amount, COALESCE(refunded_amount, 0)::numeric(12, 2) AS refunded_amount, payment_status`,
			[orderId, successDelta]
		);
		const updated = rows[0] || null;

		if (updated && successDelta > 0) {
			const total = Number(updated.total_amount) || 0;
			const refunded = Number(updated.refunded_amount) || 0;
			const fullyRefunded = total > 0 ? (total - refunded) <= 0.01 : refunded > 0;
			const nextPaymentStatus = fullyRefunded ? 'refunded' : 'partial_refunded';
			const prevPaymentStatus = String(updated.payment_status || '').trim().toLowerCase();
			const { rowCount } = await client.query(
				`UPDATE orders
				 SET payment_status = $2
				 WHERE id = $1
				 AND payment_status IS DISTINCT FROM $2`,
				[orderId, nextPaymentStatus]
			);
			if (rowCount > 0 && prevPaymentStatus !== nextPaymentStatus) {
				await insertPaymentEvent(client, { orderId, status: nextPaymentStatus, changedByAdminId: admin });
			}
		}

		await client.query('COMMIT');
		return { successDelta };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		// Best-effort release lock flag so admin isn't stuck.
		try {
			await pool.query(
				`UPDATE orders
				 SET refund_in_progress = false
				 WHERE id = $1`,
				[orderId]
			);
		} catch {
			// ignore
		}
		throw err;
	} finally {
		client.release();
	}
}

function normalizeOrderStatus(value) {
	const v = String(value || '').trim().toLowerCase();
	return ALLOWED_ORDER_STATUSES.has(v) ? v : 'pending';
}

function isUuid(v) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

function buildVariantKey({ selectedSize = '', selectedColor = '' } = {}) {
	const s = selectedSize == null ? '' : String(selectedSize);
	const c = selectedColor == null ? '' : String(selectedColor);
	return JSON.stringify([s, c]);
}

function normalizeOptionArray(value) {
	if (!Array.isArray(value)) return [];
	return value
		.map((x) => (x == null ? '' : String(x)).trim())
		.filter(Boolean);
}

function normalizeVariantSelection({ product, selectedSizeRaw, selectedColorRaw }) {
	const sizeOptions = normalizeOptionArray(product?.size_options);
	const colorOptions = normalizeOptionArray(product?.color_options);

	let selectedSize = selectedSizeRaw == null ? '' : String(selectedSizeRaw).trim();
	let selectedColor = selectedColorRaw == null ? '' : String(selectedColorRaw).trim();

	// Auto-select when there is exactly one choice.
	if (!selectedSize && sizeOptions.length === 1) selectedSize = sizeOptions[0];
	if (!selectedColor && colorOptions.length === 1) selectedColor = colorOptions[0];

	// Enforce selection when there are multiple choices.
	if (sizeOptions.length > 1 && !selectedSize) {
		const err = new Error('Missing size selection');
		err.statusCode = 400;
		err.code = 'MISSING_SIZE';
		throw err;
	}
	if (colorOptions.length > 1 && !selectedColor) {
		const err = new Error('Missing color selection');
		err.statusCode = 400;
		err.code = 'MISSING_COLOR';
		throw err;
	}

	// Validate against configured options.
	if (selectedSize && sizeOptions.length > 0 && !sizeOptions.includes(selectedSize)) {
		const err = new Error('Invalid size selection');
		err.statusCode = 400;
		err.code = 'INVALID_SIZE';
		throw err;
	}
	if (selectedColor && colorOptions.length > 0 && !colorOptions.includes(selectedColor)) {
		const err = new Error('Invalid color selection');
		err.statusCode = 400;
		err.code = 'INVALID_COLOR';
		throw err;
	}

	// Ignore incoming selections when product has no options.
	if (sizeOptions.length === 0) selectedSize = '';
	if (colorOptions.length === 0) selectedColor = '';

	return {
		selectedSize,
		selectedColor,
		variantKey: buildVariantKey({ selectedSize, selectedColor }),
	};
}

function normalizePaymentStatus(value) {
	const v = String(value || '').trim().toLowerCase();
	return ALLOWED_PAYMENT_STATUSES.has(v) ? v : 'pending';
}

async function getOrderPaymentInfo(orderId) {
	if (!isUuid(orderId)) return null;
	const { rows } = await pool.query(
		`SELECT
			id,
			tracking_code,
			total_amount,
			payment_token,
			payment_id,
			payment_status
		 FROM orders
		 WHERE id = $1
		 LIMIT 1`,
		[orderId]
	);
	return rows[0] || null;
}

async function getOrderIdByPaymentToken(paymentToken) {
	const token = String(paymentToken || '').trim();
	if (!token) return null;
	const { rows } = await pool.query(
		`SELECT id
		 FROM orders
		 WHERE payment_token = $1
		 LIMIT 1`,
		[token]
	);
	return rows[0]?.id || null;
}

async function setOrderPaymentInit({ orderId, paymentToken }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const token = String(paymentToken || '').trim();
	if (!token) {
		const err = new Error('Invalid payment token');
		err.statusCode = 400;
		throw err;
	}
	await pool.query(
		`UPDATE orders
		 SET payment_token = $2,
		 	 payment_status = 'pending'
		 WHERE id = $1`,
		[orderId, token]
	);
}

async function setOrderPaymentStatus({ orderId, paymentStatus, paymentId = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const status = normalizePaymentStatus(paymentStatus);
	const pid = paymentId == null ? null : String(paymentId).trim() || null;
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rowCount } = await client.query(
			`UPDATE orders
			 SET payment_status = $2,
			 	 payment_id = COALESCE($3, payment_id),
			 	 payment_error_code = CASE WHEN $2 <> 'failed' THEN NULL ELSE payment_error_code END,
			 	 payment_error_message = CASE WHEN $2 <> 'failed' THEN NULL ELSE payment_error_message END,
			 	 payment_error_group = CASE WHEN $2 <> 'failed' THEN NULL ELSE payment_error_group END,
			 	 payment_error_raw = CASE WHEN $2 <> 'failed' THEN NULL ELSE payment_error_raw END,
			 	 payment_error_at = CASE WHEN $2 <> 'failed' THEN NULL ELSE payment_error_at END
			 WHERE id = $1
			 AND payment_status IS DISTINCT FROM $2`,
			[orderId, status, pid]
		);
		if (rowCount > 0) {
			await insertPaymentEvent(client, { orderId, status, changedByAdminId: null });
		}
		await client.query('COMMIT');
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function setOrderPaymentFailureDetails({ orderId, paymentId = null, errorCode = null, errorMessage = null, errorGroup = null, raw = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const pid = paymentId == null ? null : String(paymentId).trim() || null;
	const code = errorCode == null ? null : String(errorCode).trim() || null;
	const msg = errorMessage == null ? null : String(errorMessage).trim() || null;
	const grp = errorGroup == null ? null : String(errorGroup).trim() || null;
	const rawJson = raw == null ? null : raw;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rowCount } = await client.query(
			`UPDATE orders
			 SET payment_status = 'failed',
			 	 payment_id = COALESCE($2, payment_id),
			 	 payment_error_code = $3,
			 	 payment_error_message = $4,
			 	 payment_error_group = $5,
			 	 payment_error_raw = $6,
			 	 payment_error_at = now()
			 WHERE id = $1
			 AND payment_status IS DISTINCT FROM 'failed'`,
			[orderId, pid, code, msg, grp, rawJson]
		);
		if (rowCount > 0) {
			await insertPaymentEvent(client, { orderId, status: 'failed', changedByAdminId: null });
		}
		await client.query('COMMIT');
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function finalizePaidOrderAndDecrementStock({ orderId, paymentId = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const pid = paymentId == null ? null : String(paymentId).trim() || null;

	const client = await pool.connect();
	const lowStockNotifies = [];
	let stockError = null;
	try {
		await client.query('BEGIN');

		const { rows: orderRows } = await client.query(
			`SELECT id, tracking_code, total_amount, payment_status
			 FROM orders
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = orderRows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}

		const currentPaymentStatus = String(order.payment_status || '').trim().toLowerCase();
		if (currentPaymentStatus === 'paid') {
			await client.query('COMMIT');
			return {
				orderId,
				trackingCode: order.tracking_code,
				totalAmount: order.total_amount,
				alreadyPaid: true,
			};
		}
		// Allow recovery: an order may be marked 'failed' due to transient callback/retrieve issues,
		// but can later be confirmed as paid by Iyzipay.
		if (currentPaymentStatus !== 'pending' && currentPaymentStatus !== 'failed') {
			const err = new Error('Order payment status is not pending');
			err.statusCode = 409;
			throw err;
		}

		// Important: once Iyzipay confirms payment success, persist payment_status='paid'
		// even if stock decrement fails (stock can be handled manually; payment cannot be "unpaid").
		await client.query(
			`UPDATE orders
			 SET payment_status = 'paid',
		 	 payment_id = COALESCE($2, payment_id),
		 	 payment_error_code = NULL,
		 	 payment_error_message = NULL,
		 	 payment_error_group = NULL,
		 	 payment_error_raw = NULL,
		 	 payment_error_at = NULL
			 WHERE id = $1`,
			[orderId, pid]
		);
		await insertPaymentEvent(client, { orderId, status: 'paid', changedByAdminId: null });

		await client.query('SAVEPOINT after_payment_mark');
		try {
			const { rows: items } = await client.query(
				`SELECT
					oi.product_id,
					oi.quantity,
					oi.variant_key,
					oi.selected_size,
					oi.selected_color,
					p.size_options,
					p.color_options,
					p.share_stock_across_colors
				 FROM order_items oi
				 LEFT JOIN products p ON p.id = oi.product_id
				 WHERE oi.order_id = $1`,
				[orderId]
			);

			for (const it of items) {
				const qty = Math.max(0, Number(it.quantity) || 0);
				const productId = it.product_id;
				if (!productId || qty <= 0) continue;

				const hasOptions = (Array.isArray(it.size_options) && it.size_options.length > 0)
					|| (Array.isArray(it.color_options) && it.color_options.length > 0);
				const shareAcrossColors = !!it.share_stock_across_colors;
				const variantKey = String(it.variant_key || '').trim();
				const selectedSize = it.selected_size == null ? null : String(it.selected_size).trim() || null;
				const selectedColor = it.selected_color == null ? null : String(it.selected_color).trim() || null;

				if (hasOptions) {
					if (shareAcrossColors && selectedSize != null) {
						const selSize = String(selectedSize || '');
						const { rows: cntRows } = await client.query(
							`SELECT COUNT(*)::int AS cnt
							 FROM product_variants
							 WHERE product_id = $1
							 AND COALESCE(selected_size, '') = $2`,
							[productId, selSize]
						);
						const expected = Number(cntRows?.[0]?.cnt) || 0;
						if (expected <= 0) {
							const err = new Error('Insufficient stock');
							err.statusCode = 409;
							throw err;
						}
						const vres = await client.query(
							`UPDATE product_variants
							 SET stock = stock - $3,
						 	 updated_at = now()
							 WHERE product_id = $1
							 AND COALESCE(selected_size, '') = $2
							 AND stock >= $3
							 RETURNING stock`,
							[productId, selSize, qty]
						);
						if (vres.rowCount !== expected) {
							const err = new Error('Insufficient stock');
							err.statusCode = 409;
							throw err;
						}
					} else {
						const vres = await client.query(
							`UPDATE product_variants
							 SET stock = stock - $3,
						 	 updated_at = now()
							 WHERE product_id = $1
							 AND variant_key = $2
							 AND stock >= $3
							 RETURNING stock`,
							[productId, variantKey, qty]
						);
						if (vres.rowCount !== 1) {
							const err = new Error('Insufficient stock');
							err.statusCode = 409;
							throw err;
						}
					}
				}

				const updateResult = await client.query(
					`UPDATE products
					 SET stock = stock - $2
					 WHERE id = $1
					 AND stock >= $2
					 RETURNING id, name, stock, low_stock_threshold`,
					[productId, qty]
				);
				if (updateResult.rowCount !== 1) {
					const err = new Error('Insufficient stock');
					err.statusCode = 409;
					throw err;
				}

				try {
					const row = updateResult.rows && updateResult.rows[0] ? updateResult.rows[0] : null;
					if (row) {
						const nextStock = Number(row.stock);
						const threshold = Number.isFinite(Number(row.low_stock_threshold))
							? Math.max(0, Math.floor(Number(row.low_stock_threshold)))
							: 5;
						const prevStock = Number.isFinite(nextStock) ? nextStock + Math.abs(qty) : NaN;
						const wasLow = Number.isFinite(prevStock) ? prevStock <= threshold : false;
						const isLow = Number.isFinite(nextStock) ? nextStock <= threshold : false;
						if (!wasLow && isLow) {
							lowStockNotifies.push({
								productId: String(row.id),
								productName: String(row.name || '').trim() || null,
								stock: Number.isFinite(nextStock) ? nextStock : null,
								threshold,
							});
						}
					}
				} catch {
					// ignore
				}

				await client.query(
					`INSERT INTO product_stock_events (
						product_id,
						order_id,
						delta,
						reason,
						variant_key,
						selected_size,
						selected_color,
						changed_by_admin_id
					)
					VALUES ($1, $2, $3, 'iyzico_payment', $4, $5, $6, NULL)`,
					[productId, orderId, -Math.abs(qty), hasOptions ? variantKey : null, hasOptions ? selectedSize : null, hasOptions ? selectedColor : null]
				);
			}
		} catch (err) {
			stockError = err;
			try { await client.query('ROLLBACK TO SAVEPOINT after_payment_mark'); } catch { /* ignore */ }
		}
		try { await client.query('RELEASE SAVEPOINT after_payment_mark'); } catch { /* ignore */ }

		await client.query('COMMIT');

		if (!stockError && lowStockNotifies.length > 0) {
			setImmediate(() => {
				Promise.allSettled(lowStockNotifies.map((p) => notifyLowStockCrossingAdmin(p))).catch(() => {});
			});
		}

		if (stockError) {
			logger.error('[order] stock decrement failed after successful payment (order marked paid)', {
				orderId,
				code: stockError?.code,
				statusCode: stockError?.statusCode,
				message: stockError?.message,
				stack: stockError?.stack,
			});
		}
		return {
			orderId,
			trackingCode: order.tracking_code,
			totalAmount: order.total_amount,
			alreadyPaid: false,
			stockDecremented: !stockError,
		};
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function findCustomerByEmail(email) {
	const normalized = String(email || '').trim().toLowerCase();
	if (!normalized) return null;
	const { rows } = await pool.query(
		`SELECT id, full_name, phone, email
		 FROM customers
		 WHERE email = $1
		 LIMIT 1`,
		[normalized]
	);
	return rows[0] || null;
}

async function findCustomerByPhone(phone) {
	const normalized = String(phone || '').trim();
	if (!normalized) return null;
	const { rows } = await pool.query(
		`SELECT id, full_name, phone, email
		 FROM customers
		 WHERE phone = $1
		 LIMIT 1`,
		[normalized]
	);
	return rows[0] || null;
}

async function upsertCustomer({ fullName, phone, email }) {
	const name = String(fullName || '').trim() || null;
	const normalizedEmail = String(email || '').trim().toLowerCase() || null;
	const normalizedPhone = String(phone || '').trim() || null;

	// No identifiers; allow anonymous orders.
	if (!normalizedEmail && !normalizedPhone) return null;

	// The customers table has UNIQUE(email) and UNIQUE(phone). Some users can exist
	// under email-only and phone-only rows (e.g., guest checkout vs Google login).
	// We must gracefully merge these rows to avoid unique constraint violations.
	for (let attempt = 0; attempt < 2; attempt++) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');

			const emailRow = normalizedEmail
				? (await client.query(
					`SELECT id, full_name, phone, email
					 FROM customers
					 WHERE email = $1
					 LIMIT 1
					 FOR UPDATE`,
					[normalizedEmail]
				)).rows[0]
				: null;
			const phoneRow = normalizedPhone
				? (await client.query(
					`SELECT id, full_name, phone, email
					 FROM customers
					 WHERE phone = $1
					 LIMIT 1
					 FOR UPDATE`,
					[normalizedPhone]
				)).rows[0]
				: null;

			// Case: both identifiers exist but refer to different customer rows.
			// Merge all FK references into the email row (stable identity), then delete the phone row.
			if (emailRow && phoneRow && String(emailRow.id) !== String(phoneRow.id)) {
				const primaryId = emailRow.id;
				const secondaryId = phoneRow.id;

				await client.query(
					`UPDATE orders
					 SET user_id = $1
					 WHERE user_id = $2`,
					[primaryId, secondaryId]
				);
				await client.query(
					`UPDATE order_cancellation_requests
					 SET requested_by_customer_id = $1
					 WHERE requested_by_customer_id = $2`,
					[primaryId, secondaryId]
				);
				await client.query(
					`UPDATE appointments
					 SET customer_id = $1
					 WHERE customer_id = $2`,
					[primaryId, secondaryId]
				);

				await client.query(
					`DELETE FROM customers
					 WHERE id = $1`,
					[secondaryId]
				);

				await client.query(
					`UPDATE customers
					 SET full_name = COALESCE($2, full_name),
					 	phone = COALESCE($3, phone),
					 	email = COALESCE($4, email),
					 	updated_at = now()
					 WHERE id = $1`,
					[primaryId, name, normalizedPhone, normalizedEmail]
				);

				await client.query('COMMIT');
				return primaryId;
			}

			const existing = emailRow || phoneRow;
			if (existing) {
				await client.query(
					`UPDATE customers
					 SET full_name = COALESCE($2, full_name),
					 	phone = COALESCE($3, phone),
					 	email = COALESCE($4, email),
					 	updated_at = now()
					 WHERE id = $1`,
					[existing.id, name, normalizedPhone, normalizedEmail]
				);
				await client.query('COMMIT');
				return existing.id;
			}

			// No existing match; attempt insert.
			try {
				const { rows } = await client.query(
					`INSERT INTO customers (full_name, phone, email)
					 VALUES ($1, $2, $3)
					 RETURNING id`,
					[name, normalizedPhone, normalizedEmail]
				);
				await client.query('COMMIT');
				return rows[0].id;
			} catch (e) {
				// Unique violation (race with another insert). Retry once.
				if (e && e.code === '23505' && attempt === 0) {
					await client.query('ROLLBACK');
					continue;
				}
				throw e;
			}
		} catch (err) {
			try { await client.query('ROLLBACK'); } catch { /* ignore */ }
			throw err;
		} finally {
			client.release();
		}
	}

	// If we got here, the retry also failed; bubble up a clear error.
	const err = new Error('Could not upsert customer');
	err.code = 'CUSTOMER_UPSERT_FAILED';
	throw err;
}

async function createOrderFromCart({
	userId = null,
	shopUserId = null,
	shippingAddress,
	cartItems,
	customerFullName = null,
	customerPhone = null,
	customerEmail = null,
}) {
	// cartItems: [{ productId, quantity }]
	if (!Array.isArray(cartItems) || cartItems.length === 0) {
		const err = new Error('Cart is empty');
		err.statusCode = 400;
		throw err;
	}
	const address = String(shippingAddress || '').trim();
	if (!address) {
		const err = new Error('Shipping address is required');
		err.statusCode = 400;
		throw err;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const productIds = cartItems.map((x) => x.productId);
		const { rows: products } = await client.query(
			`SELECT id, name, price, stock, is_active, size_options, color_options, share_stock_across_colors
			 FROM products
			 WHERE id = ANY($1::uuid[])`,
			[productIds]
		);

		const productById = new Map(products.map((p) => [p.id, p]));
		let totalAmount = 0;
		const normalizedItems = [];

		for (const item of cartItems) {
			const qty = Number(item.quantity);
			if (!Number.isInteger(qty) || qty <= 0) {
				const err = new Error('Invalid cart quantity');
				err.statusCode = 400;
				throw err;
			}
			const product = productById.get(item.productId);
			if (!product || product.is_active !== true) {
				const err = new Error('Product not available');
				err.statusCode = 400;
				throw err;
			}
			const sel = normalizeVariantSelection({
				product,
				selectedSizeRaw: item.selectedSize ?? item.selected_size ?? null,
				selectedColorRaw: item.selectedColor ?? item.selected_color ?? null,
			});
			const requiresVariantStock = (Array.isArray(product.size_options) && product.size_options.length > 0)
				|| (Array.isArray(product.color_options) && product.color_options.length > 0);

			// priceAtPurchase will be computed after loading variant pricing.
			normalizedItems.push({
				productId: product.id,
				quantity: qty,
				priceAtPurchase: null,
				selectedSize: sel.selectedSize || null,
				selectedColor: sel.selectedColor || null,
				variantKey: sel.variantKey,
				requiresVariantStock,
			});
		}

		// Validate stock using variant stock when applicable.
		// If a product shares stock across colors, validate using a per-size shared pool (min across colors).
		let variantStockMap = new Map();
		let sharedStockBySizeMap = new Map();
		let variantPriceMap = new Map();
		const need = normalizedItems.filter((x) => x.requiresVariantStock);
		if (need.length > 0) {
			const needRegular = [];
			const needShared = [];
			for (const it of need) {
				const p = productById.get(it.productId);
				const share = !!p?.share_stock_across_colors;
				if (share) needShared.push(it);
				else needRegular.push(it);
			}

			if (needRegular.length > 0) {
				const productIds2 = needRegular.map((x) => x.productId);
				const variantKeys2 = needRegular.map((x) => x.variantKey);
				const { rows: vrows } = await client.query(
					`WITH pairs AS (
						SELECT *
						FROM unnest($1::uuid[], $2::text[]) AS t(product_id, variant_key)
					)
					SELECT pv.product_id, pv.variant_key, pv.stock, pv.price
					FROM product_variants pv
					JOIN pairs p
						ON p.product_id = pv.product_id
						AND p.variant_key = pv.variant_key`,
					[productIds2, variantKeys2]
				);
				variantStockMap = new Map(vrows.map((r) => [`${r.product_id}::${r.variant_key}`, Number(r.stock) || 0]));
				variantPriceMap = new Map(vrows.map((r) => [`${r.product_id}::${r.variant_key}`, r.price === null || r.price === undefined ? null : Number(r.price)]));
			}

			if (needShared.length > 0) {
				// Price can still vary by color, so keep per-variant price lookups too.
				const productIds3 = needShared.map((x) => x.productId);
				const variantKeys3 = needShared.map((x) => x.variantKey);
				const sizes3 = needShared.map((x) => String(x.selectedSize || ''));

				const { rows: priceRows } = await client.query(
					`WITH pairs AS (
						SELECT *
						FROM unnest($1::uuid[], $2::text[]) AS t(product_id, variant_key)
					)
					SELECT pv.product_id, pv.variant_key, pv.price
					FROM product_variants pv
					JOIN pairs p
						ON p.product_id = pv.product_id
						AND p.variant_key = pv.variant_key`,
					[productIds3, variantKeys3]
				);
				for (const r of priceRows) {
					variantPriceMap.set(
						`${r.product_id}::${r.variant_key}`,
						r.price === null || r.price === undefined ? null : Number(r.price)
					);
				}

				const { rows: srows } = await client.query(
					`WITH pairs AS (
						SELECT *
						FROM unnest($1::uuid[], $2::text[]) AS t(product_id, selected_size)
					)
					SELECT
						pv.product_id,
						COALESCE(pv.selected_size, '') AS selected_size,
						MIN(pv.stock)::int AS shared_stock
					FROM product_variants pv
					JOIN pairs p
						ON p.product_id = pv.product_id
						AND COALESCE(pv.selected_size, '') = p.selected_size
					GROUP BY pv.product_id, COALESCE(pv.selected_size, '')`,
					[productIds3, sizes3]
				);
				sharedStockBySizeMap = new Map(srows.map((r) => [`${r.product_id}::${String(r.selected_size || '')}`, Number(r.shared_stock) || 0]));
			}
		}
		for (const it of normalizedItems) {
			const product = productById.get(it.productId);
			const fallback = Math.max(0, Number(product?.stock) || 0);
			const key = `${it.productId}::${it.variantKey}`;
			const shareAcrossColors = !!product?.share_stock_across_colors;
			const sizeKey = `${it.productId}::${String(it.selectedSize || '')}`;
			const available = it.requiresVariantStock
				? (shareAcrossColors && sharedStockBySizeMap.has(sizeKey)
					? Math.max(0, Number(sharedStockBySizeMap.get(sizeKey)) || 0)
					: (variantStockMap.has(key) ? Math.max(0, Number(variantStockMap.get(key)) || 0) : fallback))
				: fallback;
			if (available < it.quantity) {
				const err = new Error('Insufficient stock');
				err.statusCode = 400;
				throw err;
			}

			const basePrice = Number(product?.price);
			const overrideRaw = it.requiresVariantStock && variantPriceMap.has(key) ? variantPriceMap.get(key) : null;
			const overrideNum = overrideRaw === null || overrideRaw === undefined ? NaN : Number(overrideRaw);
			const unitPrice = Number.isFinite(overrideNum) && overrideNum >= 0 ? overrideNum : basePrice;
			it.priceAtPurchase = unitPrice;
			totalAmount += unitPrice * Number(it.quantity);
		}

		const shopUid = shopUserId && isUuid(shopUserId) ? shopUserId : null;
		const cName = customerFullName == null ? null : String(customerFullName).trim().slice(0, 200) || null;
		const cPhone = customerPhone == null ? null : String(customerPhone).trim().slice(0, 30) || null;
		const cEmail = customerEmail == null ? null : String(customerEmail).trim().toLowerCase().slice(0, 200) || null;
		let order = null;
		let trackingCode = null;
		for (let attempt = 0; attempt < 5; attempt++) {
			trackingCode = generateTrackingCode();
			try {
				const { rows: orderRows } = await client.query(
					`INSERT INTO orders (
						user_id,
						shop_user_id,
						customer_full_name,
						customer_phone,
						customer_email,
						tracking_code,
						total_amount,
						status,
						shipping_address
					)
					VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
					 RETURNING id, created_at`,
					[userId, shopUid, cName, cPhone, cEmail, trackingCode, totalAmount, address]
				);
				order = orderRows[0];
				break;
			} catch (e) {
				// Unique violation on tracking_code -> regenerate
				if (e && e.code === '23505') continue;
				throw e;
			}
		}
		if (!order || !trackingCode) {
			const err = new Error('Could not generate tracking code');
			err.statusCode = 500;
			throw err;
		}

		await client.query(
			`INSERT INTO order_status_events (order_id, status, changed_by_admin_id)
			 VALUES ($1, 'pending', NULL)`,
			[order.id]
		);

		for (const it of normalizedItems) {
			await client.query(
				`INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase, selected_size, selected_color, variant_key)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[order.id, it.productId, it.quantity, it.priceAtPurchase, it.selectedSize, it.selectedColor, it.variantKey]
			);
		}

		await client.query('COMMIT');
		return { orderId: order.id, createdAt: order.created_at, totalAmount, trackingCode };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function getOrderByTrackingCode(trackingCode) {
	const code = normalizeTrackingCode(trackingCode);
	if (!code) return null;
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.user_id,
			COALESCE(o.customer_full_name, cu.full_name) AS customer_full_name,
			COALESCE(o.customer_phone, cu.phone) AS customer_phone,
			COALESCE(o.customer_email, cu.email) AS customer_email,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.status,
			o.payment_id,
			o.payment_status,
			o.shipping_address,
			o.created_at
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 WHERE o.tracking_code = $1
		 AND o.payment_status IN ('paid', 'partial_refunded', 'refunded')
		 AND (
			o.status IS DISTINCT FROM 'cancelled'
			OR o.payment_status IN ('partial_refunded', 'refunded')
		 )
		 LIMIT 1`,
		[code]
	);
	return rows[0] || null;
}

async function getOrderDetailByTrackingCode(trackingCode) {
	const order = await getOrderByTrackingCode(trackingCode);
	if (!order) return null;

	const { rows: items } = await pool.query(
		`SELECT
			oi.id,
			oi.product_id,
			oi.quantity,
			oi.price_at_purchase,
			oi.selected_size,
			oi.selected_color,
			oi.variant_key,
			p.name AS product_name
		 FROM order_items oi
		 LEFT JOIN products p ON p.id = oi.product_id
		 WHERE oi.order_id = $1
		 ORDER BY oi.id ASC`,
		[order.id]
	);

	const events = await listOrderStatusEvents(order.id);
	const paymentEvents = await listOrderPaymentEvents(order.id);
	return { ...order, items, events, paymentEvents };
}

async function listOrderItemsForOrders(orderIds) {
	const ids = (orderIds || []).filter(Boolean);
	if (ids.length === 0) return [];
	const { rows } = await pool.query(
		`SELECT
			oi.order_id,
			oi.quantity,
			oi.price_at_purchase,
			oi.selected_size,
			oi.selected_color,
			oi.variant_key,
			p.name AS product_name
		 FROM order_items oi
		 LEFT JOIN products p ON p.id = oi.product_id
		 WHERE oi.order_id = ANY($1::uuid[])
		 ORDER BY oi.order_id ASC, oi.id ASC`,
		[ids]
	);
	return rows;
}

async function listOrders({ limit = 50 } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.user_id,
			COALESCE(o.customer_full_name, cu.full_name) AS customer_full_name,
			COALESCE(o.customer_phone, cu.phone) AS customer_phone,
			COALESCE(o.customer_email, cu.email) AS customer_email,
			o.total_amount,
			o.refunded_amount,
			o.status,
			o.payment_id,
			o.payment_status,
			o.payment_error_code,
			o.payment_error_message,
			o.payment_error_group,
			o.payment_error_at,
			o.shipping_address,
			o.created_at,
			(
				SELECT COALESCE(SUM(oi.quantity), 0)::int
				FROM order_items oi
				WHERE oi.order_id = o.id
			) AS items_count
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 ORDER BY o.created_at DESC
		 LIMIT $1`,
		[lim]
	);
	return rows;
}

async function listPaidOrders({ limit = 50 } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.user_id,
			COALESCE(o.customer_full_name, cu.full_name) AS customer_full_name,
			COALESCE(o.customer_phone, cu.phone) AS customer_phone,
			COALESCE(o.customer_email, cu.email) AS customer_email,
			o.total_amount,
			o.refunded_amount,
			o.status,
			o.payment_id,
			o.payment_status,
			o.payment_error_code,
			o.payment_error_message,
			o.payment_error_group,
			o.payment_error_at,
			o.shipping_address,
			o.created_at,
			(
				SELECT COALESCE(SUM(oi.quantity), 0)::int
				FROM order_items oi
				WHERE oi.order_id = o.id
			) AS items_count
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 WHERE o.payment_status = 'paid'
		 AND o.status IS DISTINCT FROM 'cancelled'
		 ORDER BY o.created_at DESC
		 LIMIT $1`,
		[lim]
	);
	return rows;
}

async function listOrdersForShopAdmin({ limit = 50, scope = 'paid', paymentStatus = 'all', orderStatus = 'all', search = null } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const sc = String(scope || 'paid').trim().toLowerCase();
	const scopeNormalized = (sc === 'all' || sc === 'history') ? 'all' : 'paid';

	const ps = String(paymentStatus || 'all').trim().toLowerCase();
	// NOTE: We intentionally never list payment "pending" or "failed" orders in ShopAdmin.
	const allowedPayment = new Set(['paid', 'partial_refunded', 'refunded', 'all']);
	const paymentNormalized = allowedPayment.has(ps) ? ps : 'all';

	const os = String(orderStatus || 'all').trim().toLowerCase();
	const allowedOrder = new Set(['pending', 'shipped', 'completed', 'cancelled', 'all']);
	const orderNormalized = allowedOrder.has(os) ? os : 'all';
	const q = search == null ? null : String(search).trim().slice(0, 200) || null;

	const where = [];
	const params = [];

	// Global rule: never show payment-pending/failed (or NULL treated as pending) orders.
	where.push("COALESCE(o.payment_status, 'pending') NOT IN ('pending', 'failed')");

	if (scopeNormalized === 'paid') {
		// Default ShopAdmin view: only successfully paid orders (excluding cancelled).
		where.push("o.payment_status = 'paid'");
		where.push("o.status IS DISTINCT FROM 'cancelled'");
	}
	if (paymentNormalized !== 'all') {
		params.push(paymentNormalized);
		where.push(`o.payment_status = $${params.length}`);
	}
	if (orderNormalized !== 'all') {
		params.push(orderNormalized);
		where.push(`o.status = $${params.length}`);
	}
	if (q) {
		params.push(`%${q}%`);
		const idx = params.length;
		where.push(`(
			o.tracking_code ILIKE $${idx}
			OR o.id::text ILIKE $${idx}
			OR o.payment_id::text ILIKE $${idx}
			OR COALESCE(o.customer_full_name, cu.full_name, '') ILIKE $${idx}
			OR COALESCE(o.customer_email, cu.email, '') ILIKE $${idx}
			OR COALESCE(o.customer_phone, cu.phone, '') ILIKE $${idx}
		)`);
	}

	params.push(lim);
	const whereSql = where.length ? `WHERE ${where.join('\n\t\t AND ')}` : '';

	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.user_id,
			COALESCE(o.customer_full_name, cu.full_name) AS customer_full_name,
			COALESCE(o.customer_phone, cu.phone) AS customer_phone,
			COALESCE(o.customer_email, cu.email) AS customer_email,
			o.total_amount,
			o.refunded_amount,
			o.status,
			o.payment_id,
			o.payment_status,
			o.payment_error_code,
			o.payment_error_message,
			o.payment_error_group,
			o.payment_error_at,
			o.shipping_address,
			o.created_at,
			(
				SELECT COALESCE(SUM(oi.quantity), 0)::int
				FROM order_items oi
				WHERE oi.order_id = o.id
			) AS items_count
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 ${whereSql}
		 ORDER BY o.created_at DESC
		 LIMIT $${params.length}`,
		params
	);
	return rows;
}

async function getOrderWithItems(orderId) {
	const { rows: orderRows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.user_id,
			o.shop_user_id,
			COALESCE(o.customer_full_name, cu.full_name) AS customer_full_name,
			COALESCE(o.customer_phone, cu.phone) AS customer_phone,
			COALESCE(o.customer_email, cu.email) AS customer_email,
			o.total_amount,
			o.refunded_amount,
			o.refunded_at,
			o.refund_in_progress,
			o.status,
			o.payment_token,
			o.payment_id,
			o.payment_status,
			o.payment_items,
			o.payment_error_code,
			o.payment_error_message,
			o.payment_error_group,
			o.payment_error_at,
			o.shipping_address,
			o.created_at
		 FROM orders o
		 LEFT JOIN customers cu ON cu.id = o.user_id
		 WHERE o.id = $1
		 LIMIT 1`,
		[orderId]
	);
	const order = orderRows[0] || null;
	if (!order) return null;

	const { rows: items } = await pool.query(
		`SELECT
			oi.id,
			oi.product_id,
			oi.quantity,
			oi.price_at_purchase,
			oi.selected_size,
			oi.selected_color,
			oi.variant_key,
			p.name AS product_name
		 FROM order_items oi
		 LEFT JOIN products p ON p.id = oi.product_id
		 WHERE oi.order_id = $1
		 ORDER BY oi.id ASC`,
		[orderId]
	);

	return { ...order, items };
}

async function listOrderPaymentEvents(orderId) {
	try {
		const { rows } = await pool.query(
			`SELECT
				pe.id,
				pe.status,
				pe.created_at,
				a.full_name AS changed_by_admin_name
			 FROM order_payment_events pe
			 LEFT JOIN admins a ON a.id = pe.changed_by_admin_id
			 WHERE pe.order_id = $1
			 ORDER BY pe.created_at DESC`,
			[orderId]
		);
		return rows;
	} catch {
		// If migration isn't applied yet, don't break order pages.
		return [];
	}
}

async function listOrderStatusEvents(orderId) {
	const { rows } = await pool.query(
		`SELECT
			oe.id,
			oe.status,
			oe.created_at,
			a.full_name AS changed_by_admin_name
		 FROM order_status_events oe
		 LEFT JOIN admins a ON a.id = oe.changed_by_admin_id
		 WHERE oe.order_id = $1
		 ORDER BY oe.created_at DESC`,
		[orderId]
	);
	return rows;
}

async function getOrderDetail(orderId) {
	const order = await getOrderWithItems(orderId);
	if (!order) return null;
	const events = await listOrderStatusEvents(orderId);
	const paymentEvents = await listOrderPaymentEvents(orderId);
	return { ...order, events, paymentEvents };
}

async function updateOrderStatus({ orderId, status, changedByAdminId = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}

	const nextStatus = normalizeOrderStatus(status);
	const allowedByCurrent = {
		pending: new Set(['pending', 'shipped', 'completed', 'cancelled']),
		shipped: new Set(['shipped', 'completed']),
		completed: new Set(['completed']),
		cancelled: new Set(['cancelled']),
	};

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const { rows: orderRows } = await client.query(
			`SELECT id, status, payment_status
			 FROM orders
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = orderRows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}

		const currentStatus = normalizeOrderStatus(order.status);
		const payStatus = String(order.payment_status || '').trim().toLowerCase();

		// Fully refunded orders are terminal in ShopAdmin; status updates should be blocked.
		if (payStatus === 'refunded' && nextStatus !== currentStatus) {
			const err = new Error('Order status is locked');
			err.statusCode = 409;
			err.code = 'STATUS_LOCKED';
			throw err;
		}

		const allowed = allowedByCurrent[currentStatus] || new Set([currentStatus]);
		if (!allowed.has(nextStatus)) {
			const err = new Error('Invalid status transition');
			err.statusCode = 409;
			err.code = 'INVALID_STATUS_TRANSITION';
			err.details = { from: currentStatus, to: nextStatus };
			throw err;
		}

		const { rowCount } = await client.query(
			`UPDATE orders
			 SET status = $2
			 WHERE id = $1
			 AND status IS DISTINCT FROM $2`,
			[orderId, nextStatus]
		);
		if (rowCount > 0) {
			await client.query(
				`INSERT INTO order_status_events (order_id, status, changed_by_admin_id)
				 VALUES ($1, $2, $3)`,
				[orderId, nextStatus, changedByAdminId]
			);
		}
		await client.query('COMMIT');
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function cancelOrderByCustomer({ orderId, customerId }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	if (!isUuid(customerId)) {
		const err = new Error('Invalid customer id');
		err.statusCode = 400;
		throw err;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const { rows: orderRows } = await client.query(
			`SELECT id, user_id, tracking_code, status, payment_status
			 FROM orders
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = orderRows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}
		if (String(order.user_id || '') !== String(customerId)) {
			const err = new Error('Forbidden');
			err.statusCode = 403;
			throw err;
		}

		const currentStatus = String(order.status || '').trim().toLowerCase();
		if (currentStatus !== 'pending') {
			const err = new Error('Order cannot be cancelled in current status');
			err.statusCode = 409;
			throw err;
		}

		const paymentStatus = String(order.payment_status || '').trim().toLowerCase();
		if (paymentStatus === 'paid' || paymentStatus === 'partial_refunded') {
			const err = new Error('Paid orders require cancellation request');
			err.statusCode = 409;
			err.code = 'PAID_ORDER';
			throw err;
		}

		// Restock only if this order previously decremented stock.
		// - New flow decrements stock only after payment approval (reason='iyzico_payment').
		// - Legacy flow may have decremented stock at order creation (reason='order').
		let shouldRestock = false;
		try {
			const { rows: ev } = await client.query(
				`SELECT 1
				 FROM product_stock_events
				 WHERE order_id = $1
				 AND delta < 0
				 AND reason IN ('order', 'iyzico_payment')
				 LIMIT 1`,
				[orderId]
			);
			shouldRestock = Boolean(ev[0]);
		} catch {
			shouldRestock = false;
		}

		if (shouldRestock) {
			const { rows: items } = await client.query(
				`SELECT
					oi.product_id,
					oi.quantity,
					oi.variant_key,
					oi.selected_size,
					oi.selected_color,
					p.size_options,
					p.color_options
				 FROM order_items oi
				 LEFT JOIN products p ON p.id = oi.product_id
				 WHERE oi.order_id = $1`,
				[orderId]
			);

			for (const it of items) {
				const qty = Math.max(0, Number(it.quantity) || 0);
				const productId = it.product_id;
				if (!productId || qty <= 0) continue;
				const hasOptions = (Array.isArray(it.size_options) && it.size_options.length > 0)
					|| (Array.isArray(it.color_options) && it.color_options.length > 0);
				const variantKey = String(it.variant_key || '').trim();
				const selectedSize = it.selected_size == null ? null : String(it.selected_size).trim() || null;
				const selectedColor = it.selected_color == null ? null : String(it.selected_color).trim() || null;

				if (hasOptions) {
					await client.query(
						`INSERT INTO product_variants (product_id, variant_key, selected_size, selected_color, stock, updated_at)
						 VALUES ($1, $2, $3, $4, $5, now())
						 ON CONFLICT (product_id, variant_key)
						 DO UPDATE SET
							stock = product_variants.stock + EXCLUDED.stock,
							updated_at = now()`,
						[productId, variantKey, selectedSize, selectedColor, Math.abs(qty)]
					);
				}

				await client.query(
					`UPDATE products
					 SET stock = stock + $2
					 WHERE id = $1`,
					[productId, qty]
				);
				await client.query(
					`INSERT INTO product_stock_events (
						product_id,
						order_id,
						delta,
						reason,
						variant_key,
						selected_size,
						selected_color,
						changed_by_admin_id
					)
					VALUES ($1, $2, $3, 'order_cancel_customer', $4, $5, $6, NULL)`,
					[productId, orderId, Math.abs(qty), hasOptions ? variantKey : null, hasOptions ? selectedSize : null, hasOptions ? selectedColor : null]
				);
			}
		}

		const { rowCount } = await client.query(
			`UPDATE orders
			 SET status = 'cancelled'
			 WHERE id = $1 AND status = 'pending'`,
			[orderId]
		);
		if (rowCount <= 0) {
			const err = new Error('Order cannot be cancelled');
			err.statusCode = 409;
			throw err;
		}
		await client.query(
			`INSERT INTO order_status_events (order_id, status, changed_by_admin_id)
			 VALUES ($1, 'cancelled', NULL)`,
			[orderId]
		);

		await client.query('COMMIT');
		return { orderId, trackingCode: order.tracking_code };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function cancelOrderByShopUser({ orderId, shopUserId, email = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	if (!isUuid(shopUserId)) {
		const err = new Error('Invalid shop user id');
		err.statusCode = 400;
		throw err;
	}
	const normalizedEmail = email == null ? null : String(email).trim().toLowerCase().slice(0, 200) || null;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const { rows: orderRows } = await client.query(
			`SELECT
				o.id,
				o.user_id,
				o.shop_user_id,
				o.tracking_code,
				o.status,
				o.payment_status,
				COALESCE(o.customer_email, cu.email) AS customer_email
			 FROM orders o
			 LEFT JOIN customers cu ON cu.id = o.user_id
			 WHERE o.id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = orderRows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}

		const ownsByShopUser = order.shop_user_id && String(order.shop_user_id) === String(shopUserId);
		const ownsByEmail = !order.shop_user_id && normalizedEmail && String(order.customer_email || '').trim().toLowerCase() === normalizedEmail;
		if (!ownsByShopUser && !ownsByEmail) {
			const err = new Error('Forbidden');
			err.statusCode = 403;
			throw err;
		}

		const currentStatus = String(order.status || '').trim().toLowerCase();
		if (currentStatus !== 'pending') {
			const err = new Error('Order cannot be cancelled in current status');
			err.statusCode = 409;
			throw err;
		}

		const paymentStatus = String(order.payment_status || '').trim().toLowerCase();
		if (paymentStatus === 'paid' || paymentStatus === 'partial_refunded') {
			const err = new Error('Paid orders require cancellation request');
			err.statusCode = 409;
			err.code = 'PAID_ORDER';
			throw err;
		}

		let shouldRestock = false;
		try {
			const { rows: ev } = await client.query(
				`SELECT 1
				 FROM product_stock_events
				 WHERE order_id = $1
				 AND delta < 0
				 AND reason IN ('order', 'iyzico_payment')
				 LIMIT 1`,
				[orderId]
			);
			shouldRestock = Boolean(ev[0]);
		} catch {
			shouldRestock = false;
		}

		if (shouldRestock) {
			const { rows: items } = await client.query(
				`SELECT
					oi.product_id,
					oi.quantity,
					oi.variant_key,
					oi.selected_size,
					oi.selected_color,
					p.size_options,
					p.color_options
				 FROM order_items oi
				 LEFT JOIN products p ON p.id = oi.product_id
				 WHERE oi.order_id = $1`,
				[orderId]
			);

			for (const it of items) {
				const qty = Math.max(0, Number(it.quantity) || 0);
				const productId = it.product_id;
				if (!productId || qty <= 0) continue;
				const hasOptions = (Array.isArray(it.size_options) && it.size_options.length > 0)
					|| (Array.isArray(it.color_options) && it.color_options.length > 0);
				const variantKey = String(it.variant_key || '').trim();
				const selectedSize = it.selected_size == null ? null : String(it.selected_size).trim() || null;
				const selectedColor = it.selected_color == null ? null : String(it.selected_color).trim() || null;

				if (hasOptions) {
					await client.query(
						`INSERT INTO product_variants (product_id, variant_key, selected_size, selected_color, stock, updated_at)
						 VALUES ($1, $2, $3, $4, $5, now())
						 ON CONFLICT (product_id, variant_key)
						 DO UPDATE SET
							stock = product_variants.stock + EXCLUDED.stock,
							updated_at = now()`,
						[productId, variantKey, selectedSize, selectedColor, Math.abs(qty)]
					);
				}

				await client.query(
					`UPDATE products
					 SET stock = stock + $2
					 WHERE id = $1`,
					[productId, qty]
				);
				await client.query(
					`INSERT INTO product_stock_events (
						product_id,
						order_id,
						delta,
						reason,
						variant_key,
						selected_size,
						selected_color,
						changed_by_admin_id
					)
					VALUES ($1, $2, $3, 'order_cancel_customer', $4, $5, $6, NULL)`,
					[productId, orderId, Math.abs(qty), hasOptions ? variantKey : null, hasOptions ? selectedSize : null, hasOptions ? selectedColor : null]
				);
			}
		}

		const { rowCount } = await client.query(
			`UPDATE orders
			 SET status = 'cancelled'
			 WHERE id = $1 AND status = 'pending'`,
			[orderId]
		);
		if (rowCount <= 0) {
			const err = new Error('Order cannot be cancelled');
			err.statusCode = 409;
			throw err;
		}
		await client.query(
			`INSERT INTO order_status_events (order_id, status, changed_by_admin_id)
			 VALUES ($1, 'cancelled', NULL)`,
			[orderId]
		);

		await client.query('COMMIT');
		return { orderId, trackingCode: order.tracking_code };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function cancelOrderAfterAdminRefund({ orderId, changedByAdminId = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const adminId = changedByAdminId && isUuid(changedByAdminId) ? changedByAdminId : null;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const { rows: orderRows } = await client.query(
			`SELECT
				id,
				status,
				payment_status,
				total_amount,
				COALESCE(refunded_amount, 0)::numeric(12, 2) AS refunded_amount
			 FROM orders
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[orderId]
		);
		const order = orderRows[0] || null;
		if (!order) {
			const err = new Error('Order not found');
			err.statusCode = 404;
			throw err;
		}

		const currentStatus = String(order.status || '').trim().toLowerCase();
		if (currentStatus !== 'pending') {
			const err = new Error('Order cannot be cancelled in current status');
			err.statusCode = 409;
			err.code = 'ORDER_STATUS';
			throw err;
		}

		const total = Number(order.total_amount) || 0;
		const refunded = Number(order.refunded_amount) || 0;
		const fullyRefunded = total > 0 ? (total - refunded) <= 0.01 : refunded > 0;
		const payStatus = String(order.payment_status || '').trim().toLowerCase();
		if (!fullyRefunded || payStatus !== 'refunded') {
			const err = new Error('Order must be fully refunded before cancellation');
			err.statusCode = 409;
			err.code = 'NOT_REFUNDED';
			throw err;
		}

		const { rows: items } = await client.query(
			`SELECT
				oi.product_id,
				oi.quantity,
				oi.variant_key,
				oi.selected_size,
				oi.selected_color,
				p.size_options,
				p.color_options
			 FROM order_items oi
			 LEFT JOIN products p ON p.id = oi.product_id
			 WHERE oi.order_id = $1`,
			[orderId]
		);
		for (const it of items) {
			const qty = Math.max(0, Number(it.quantity) || 0);
			const productId = it.product_id;
			if (!productId || qty <= 0) continue;
			const hasOptions = (Array.isArray(it.size_options) && it.size_options.length > 0)
				|| (Array.isArray(it.color_options) && it.color_options.length > 0);
			const variantKey = String(it.variant_key || '').trim();
			const selectedSize = it.selected_size == null ? null : String(it.selected_size).trim() || null;
			const selectedColor = it.selected_color == null ? null : String(it.selected_color).trim() || null;
			if (hasOptions) {
				await client.query(
					`INSERT INTO product_variants (product_id, variant_key, selected_size, selected_color, stock, updated_at)
					 VALUES ($1, $2, $3, $4, $5, now())
					 ON CONFLICT (product_id, variant_key)
					 DO UPDATE SET
						stock = product_variants.stock + EXCLUDED.stock,
						updated_at = now()`,
					[productId, variantKey, selectedSize, selectedColor, Math.abs(qty)]
				);
			}
			await client.query(
				`UPDATE products
				 SET stock = stock + $2
				 WHERE id = $1`,
				[productId, qty]
			);
			await client.query(
				`INSERT INTO product_stock_events (
					product_id,
					order_id,
					delta,
					reason,
					variant_key,
					selected_size,
					selected_color,
					changed_by_admin_id
				)
				VALUES ($1, $2, $3, 'order_cancel_admin_refund', $4, $5, $6, $7)`,
				[productId, orderId, Math.abs(qty), hasOptions ? variantKey : null, hasOptions ? selectedSize : null, hasOptions ? selectedColor : null, adminId]
			);
		}

		const { rowCount } = await client.query(
			`UPDATE orders
			 SET status = 'cancelled'
			 WHERE id = $1
			 AND status = 'pending'`,
			[orderId]
		);
		if (rowCount !== 1) {
			const err = new Error('Order cannot be cancelled');
			err.statusCode = 409;
			throw err;
		}

		await client.query(
			`INSERT INTO order_status_events (order_id, status, changed_by_admin_id)
			 VALUES ($1, 'cancelled', $2)`,
			[orderId, adminId]
		);

		await client.query('COMMIT');
		return { orderId };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function getTodayOrderStats() {
	const { rows } = await pool.query(
		`SELECT
			COUNT(*)::int AS orders_today,
			COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_today,
			COUNT(*) FILTER (WHERE status = 'shipped')::int AS shipped_today,
			COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_today,
			COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_today,
			COALESCE(
				SUM(
					(total_amount - COALESCE(refunded_amount, 0))
				),
				0
			)::numeric(12, 2) AS revenue_today
		 FROM orders
		 WHERE created_at >= date_trunc('day', now())
			AND payment_status IN ('paid', 'partial_refunded', 'refunded')`
	);
	return (
		rows[0] || {
			orders_today: 0,
			pending_today: 0,
			shipped_today: 0,
			completed_today: 0,
			cancelled_today: 0,
			revenue_today: 0,
		}
	);
}

/**
 * List orders that need reconciliation (pending payment for too long)
 */
async function listOrdersForReconciliation({ daysBefore = 7, limit = 50 } = {}) {
	const days = Math.max(1, Math.min(30, Number(daysBefore) || 7));
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	
	const { rows } = await pool.query(
		`SELECT
			id,
			payment_token,
			payment_id,
			payment_status,
			created_at
		 FROM orders
		 WHERE payment_status = 'pending'
			AND created_at > now() - ($1 || ' days')::interval
			AND created_at < now() - interval '30 minutes'
			AND (payment_token IS NOT NULL OR payment_id IS NOT NULL)
		 ORDER BY created_at DESC
		 LIMIT $2`,
		[days, lim]
	);
	return rows;
}

/**
 * Update payment status from reconciliation
 */
async function updatePaymentStatus({ orderId, paymentStatus, source = 'unknown' }) {
	if (!orderId) return null;
	if (!ALLOWED_PAYMENT_STATUSES.has(paymentStatus)) return null;

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		
		const { rows } = await client.query(
			`UPDATE orders
			 SET payment_status = $2
			 WHERE id = $1
			 RETURNING id, payment_status`,
			[orderId, paymentStatus]
		);

		if (rows[0]) {
			await insertPaymentEvent(client, { orderId, status: paymentStatus });
		}

		await client.query('COMMIT');
		
		if (rows[0]) {
			logger.info('[orderModel] payment status updated', { 
				orderId, 
				newStatus: paymentStatus, 
				source 
			});
		}
		
		return rows[0] || null;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		client.release();
	}
}

/**
 * Advanced order search with filters
 */
async function searchOrders({
	status,
	paymentStatus,
	startDate,
	endDate,
	minAmount,
	maxAmount,
	searchQuery,
	limit = 50,
	offset = 0,
} = {}) {
	const conditions = [];
	const params = [];
	let paramIndex = 1;

	if (status && ALLOWED_ORDER_STATUSES.has(status)) {
		conditions.push(`o.status = $${paramIndex++}`);
		params.push(status);
	}

	if (paymentStatus && ALLOWED_PAYMENT_STATUSES.has(paymentStatus)) {
		conditions.push(`o.payment_status = $${paramIndex++}`);
		params.push(paymentStatus);
	}

	if (startDate) {
		conditions.push(`o.created_at >= $${paramIndex++}`);
		params.push(startDate);
	}

	if (endDate) {
		conditions.push(`o.created_at <= $${paramIndex++}`);
		params.push(endDate);
	}

	if (minAmount !== undefined && minAmount !== null) {
		conditions.push(`o.total_amount >= $${paramIndex++}`);
		params.push(minAmount);
	}

	if (maxAmount !== undefined && maxAmount !== null) {
		conditions.push(`o.total_amount <= $${paramIndex++}`);
		params.push(maxAmount);
	}

	if (searchQuery) {
		const searchTerm = `%${String(searchQuery).trim()}%`;
		conditions.push(`(
			o.tracking_code ILIKE $${paramIndex} OR
			o.customer_full_name ILIKE $${paramIndex} OR
			o.customer_email ILIKE $${paramIndex} OR
			o.customer_phone ILIKE $${paramIndex}
		)`);
		params.push(searchTerm);
		paramIndex++;
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const off = Math.max(0, Number(offset) || 0);

	params.push(lim, off);

	const { rows } = await pool.query(
		`SELECT
			o.id,
			o.tracking_code,
			o.customer_full_name,
			o.customer_email,
			o.customer_phone,
			o.total_amount,
			o.refunded_amount,
			o.payment_status,
			o.status,
			o.shipping_address,
			o.created_at
		 FROM orders o
		 ${whereClause}
		 ORDER BY o.created_at DESC
		 LIMIT $${paramIndex - 1} OFFSET $${paramIndex}`,
		params
	);

	// Get total count
	const countParams = params.slice(0, -2);
	const { rows: countRows } = await pool.query(
		`SELECT COUNT(*)::int AS total FROM orders o ${whereClause}`,
		countParams
	);

	return {
		orders: rows,
		total: countRows[0]?.total || 0,
		limit: lim,
		offset: off,
	};
}

module.exports = {
	upsertCustomer,
	createOrderFromCart,
	listOrders,
	listPaidOrders,
	listOrdersForShopAdmin,
	listOrdersByTrackingCodes,
	listOrdersByCustomerId,
	listPaidOrdersByCustomerId,
	listOrdersByShopUserId,
	listPaidOrdersByShopUserId,
	listPendingOrdersWithToken,
	listOrdersForReconciliation,
	setOrderPaymentItems,
	getOrderRefundContext,
	listOrderRefunds,
	getSuccessfulRefundTotalsByTransaction,
	beginOrderRefund,
	finishOrderRefund,
	getOrderWithItems,
	getOrderDetail,
	getOrderDetailByTrackingCode,
	listOrderStatusEvents,
	listOrderPaymentEvents,
	listOrderItemsForOrders,
	updateOrderStatus,
	updatePaymentStatus,
	cancelOrderByCustomer,
	cancelOrderByShopUser,
	cancelOrderAfterAdminRefund,
	setOrderPaymentInit,
	setOrderPaymentStatus,
	setOrderPaymentFailureDetails,
	finalizePaidOrderAndDecrementStock,
	getOrderPaymentInfo,
	getOrderIdByPaymentToken,
	getTodayOrderStats,
	searchOrders,
};
