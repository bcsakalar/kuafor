const { pool } = require('../config/db');

function isUuid(v) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

async function createCancellationRequest({ orderId, customerId = null, shopUserId = null, customerNote = null }) {
	if (!isUuid(orderId)) {
		const err = new Error('Invalid order id');
		err.statusCode = 400;
		throw err;
	}
	const cid = customerId && isUuid(customerId) ? customerId : null;
	const suid = shopUserId && isUuid(shopUserId) ? shopUserId : null;
	const note = customerNote == null ? null : String(customerNote).trim().slice(0, 2000) || null;

	// Validate order ownership + eligibility.
	const { rows: orderRows } = await pool.query(
		`SELECT id, user_id, shop_user_id, status, payment_status
		 FROM orders
		 WHERE id = $1
		 LIMIT 1`,
		[orderId]
	);
	const order = orderRows[0] || null;
	if (!order) {
		const err = new Error('Order not found');
		err.statusCode = 404;
		throw err;
	}
	// Ownership: either matches customer record or authenticated shop user.
	const ownerByCustomer = cid && String(order.user_id || '') === String(cid);
	const ownerByShopUser = suid && String(order.shop_user_id || '') === String(suid);
	if (!ownerByCustomer && !ownerByShopUser) {
		const err = new Error('Forbidden');
		err.statusCode = 403;
		throw err;
	}

	const orderStatus = String(order.status || '').trim().toLowerCase();
	if (orderStatus !== 'pending') {
		const err = new Error('Order cannot be cancelled in current status');
		err.statusCode = 409;
		err.code = 'ORDER_STATUS';
		throw err;
	}
	const paymentStatus = String(order.payment_status || '').trim().toLowerCase();
	if (paymentStatus !== 'paid' && paymentStatus !== 'partial_refunded') {
		const err = new Error('Order is not eligible for cancellation request');
		err.statusCode = 409;
		err.code = 'PAYMENT_STATUS';
		throw err;
	}

	// Idempotent: if an open request already exists, return it.
	const { rows: existing } = await pool.query(
		`SELECT id, status
		 FROM order_cancellation_requests
		 WHERE order_id = $1
		 AND status = 'requested'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		[orderId]
	);
	if (existing[0]) return { requestId: existing[0].id, status: existing[0].status, alreadyExists: true };

	const { rows } = await pool.query(
		`INSERT INTO order_cancellation_requests (
			order_id,
			requested_by_customer_id,
			requested_by_shop_user_id,
			status,
			customer_note
		) VALUES ($1, $2, $3, 'requested', $4)
		RETURNING id, status`,
		[orderId, cid, suid, note]
	);
	return { requestId: rows[0].id, status: rows[0].status, alreadyExists: false };
}

async function getActiveCancellationRequestForOrder(orderId) {
	if (!isUuid(orderId)) return null;
	const { rows } = await pool.query(
		`SELECT
			id,
			order_id,
			status,
			customer_note,
			admin_note,
			processed_by_admin_id,
			created_at,
			processed_at
		 FROM order_cancellation_requests
		 WHERE order_id = $1
		 AND status = 'requested'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		[orderId]
	);
	return rows[0] || null;
}

async function getLatestCancellationRequestForOrder(orderId) {
	if (!isUuid(orderId)) return null;
	const { rows } = await pool.query(
		`SELECT
			id,
			order_id,
			status,
			customer_note,
			admin_note,
			processed_by_admin_id,
			created_at,
			processed_at
		 FROM order_cancellation_requests
		 WHERE order_id = $1
		 ORDER BY created_at DESC
		 LIMIT 1`,
		[orderId]
	);
	return rows[0] || null;
}

async function listActiveCancellationRequestsForOrders(orderIds) {
	const ids = Array.from(new Set((orderIds || []).map((x) => String(x || '').trim()).filter(isUuid)));
	if (ids.length === 0) return [];
	const { rows } = await pool.query(
		`SELECT DISTINCT ON (order_id)
			id,
			order_id,
			status,
			customer_note,
			admin_note,
			created_at,
			processed_at
		 FROM order_cancellation_requests
		 WHERE order_id = ANY($1::uuid[])
		 AND status = 'requested'
		 ORDER BY order_id, created_at DESC`,
		[ids]
	);
	return rows;
}

async function listCancellationRequests({ status = 'requested', limit = 50, search = null } = {}) {
	const st = String(status || 'requested').trim().toLowerCase();
	const allowed = new Set(['requested', 'approved', 'rejected', 'cancelled', 'all']);
	const normalized = allowed.has(st) ? st : 'requested';
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const q = search == null ? null : String(search).trim().slice(0, 200) || null;

	const where = [];
	const params = [];
	if (normalized !== 'all') {
		params.push(normalized);
		where.push(`r.status = $${params.length}`);
	}
	if (q) {
		params.push(`%${q}%`);
		const idx = params.length;
		where.push(`(
			o.tracking_code ILIKE $${idx}
			OR r.id::text ILIKE $${idx}
			OR r.order_id::text ILIKE $${idx}
		)`);
	}
	params.push(lim);
	const whereSql = where.length ? `WHERE ${where.join('\n\t\t AND ')}` : '';

	const { rows } = await pool.query(
		`SELECT
			r.id,
			r.order_id,
			r.status,
			r.customer_note,
			r.admin_note,
			r.created_at,
			r.processed_at,
			o.tracking_code,
			o.status AS order_status,
			o.payment_status,
			o.total_amount
		FROM order_cancellation_requests r
		JOIN orders o ON o.id = r.order_id
		${whereSql}
		ORDER BY r.created_at DESC
		LIMIT $${params.length}`,
		params
	);
	return rows;
}

async function getCancellationRequestById(requestId) {
	if (!isUuid(requestId)) return null;
	const { rows } = await pool.query(
		`SELECT
			r.id,
			r.order_id,
			r.status,
			r.customer_note,
			r.admin_note,
			r.created_at,
			r.processed_at,
			o.tracking_code,
			o.status AS order_status,
			o.payment_status,
			o.total_amount
		FROM order_cancellation_requests r
		JOIN orders o ON o.id = r.order_id
		WHERE r.id = $1
		LIMIT 1`,
		[requestId]
	);
	return rows[0] || null;
}

async function rejectCancellationRequest({ requestId, adminId = null, adminNote = null }) {
	if (!isUuid(requestId)) {
		const err = new Error('Invalid request id');
		err.statusCode = 400;
		throw err;
	}
	const aid = adminId && isUuid(adminId) ? adminId : null;
	const note = adminNote == null ? null : String(adminNote).trim().slice(0, 2000) || null;

	const { rows } = await pool.query(
		`UPDATE order_cancellation_requests
		 SET status = 'rejected',
		 	admin_note = COALESCE($2, admin_note),
		 	processed_by_admin_id = $3,
		 	processed_at = now()
		 WHERE id = $1
		 AND status = 'requested'
		 RETURNING id, order_id, status`,
		[requestId, note, aid]
	);
	return rows[0] || null;
}

async function approveCancellationRequestsForOrder({ orderId, adminId = null, adminNote = null }) {
	if (!isUuid(orderId)) return null;
	const aid = adminId && isUuid(adminId) ? adminId : null;
	const note = adminNote == null ? null : String(adminNote).trim().slice(0, 2000) || null;
	const { rows } = await pool.query(
		`UPDATE order_cancellation_requests
		 SET status = 'approved',
		 	admin_note = COALESCE($2, admin_note),
		 	processed_by_admin_id = $3,
		 	processed_at = now()
		 WHERE order_id = $1
		 AND status = 'requested'
		 RETURNING id, order_id, status`,
		[orderId, note, aid]
	);
	return rows[0] || null;
}

module.exports = {
	createCancellationRequest,
	getActiveCancellationRequestForOrder,
	getLatestCancellationRequestForOrder,
	listActiveCancellationRequestsForOrders,
	listCancellationRequests,
	getCancellationRequestById,
	rejectCancellationRequest,
	approveCancellationRequestsForOrder,
};
