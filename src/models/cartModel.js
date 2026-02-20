const { pool } = require('../config/db');

function buildVariantKey({ selectedSize = '', selectedColor = '' } = {}) {
	const s = selectedSize == null ? '' : String(selectedSize);
	const c = selectedColor == null ? '' : String(selectedColor);
	return JSON.stringify([s, c]);
}

function normalizeVariantKey(value) {
	const raw = value == null ? '' : String(value);
	// Keep legacy behavior: missing/empty means "no variant".
	// In DB we store this as an empty string (matches schema default and unique constraint).
	if (!raw.trim()) return '';
	// Accept our JSON format; otherwise treat as legacy raw string.
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.length === 2) {
			const selectedSize = parsed[0] ?? '';
			const selectedColor = parsed[1] ?? '';
			if (!String(selectedSize || '').trim() && !String(selectedColor || '').trim()) return '';
			return buildVariantKey({ selectedSize, selectedColor });
		}
	} catch {
		// ignore
	}
	return raw;
}

async function getOrCreateCartId(userId) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows: existing } = await client.query(
			`SELECT id
			 FROM cart
			 WHERE user_id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[userId]
		);
		if (existing[0]) {
			await client.query('COMMIT');
			return existing[0].id;
		}
		const { rows } = await client.query(
			`INSERT INTO cart (user_id)
			 VALUES ($1)
			 RETURNING id`,
			[userId]
		);
		await client.query('COMMIT');
		return rows[0].id;
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function listCartItems(userId) {
	if (!userId) return [];
	const cartId = await getOrCreateCartId(userId);
	const { rows } = await pool.query(
		`SELECT product_id, quantity, selected_size, selected_color, variant_key
		 FROM cart_items
		 WHERE cart_id = $1
		 ORDER BY created_at ASC`,
		[cartId]
	);
	return rows;
}

async function countCartItems(userId) {
	if (!userId) return 0;
	const cartId = await getOrCreateCartId(userId);
	const { rows } = await pool.query(
		`SELECT COALESCE(SUM(quantity), 0)::int AS cnt
		 FROM cart_items
		 WHERE cart_id = $1`,
		[cartId]
	);
	return Number(rows[0] && rows[0].cnt) || 0;
}

async function upsertCartItem({ userId, productId, quantity, selectedSize = '', selectedColor = '', variantKey = null }) {
	if (!userId) throw new Error('userId is required');
	if (!productId) throw new Error('productId is required');
	const qty = Number(quantity);
	if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
		const err = new Error('Invalid quantity');
		err.statusCode = 400;
		throw err;
	}
	const vkey = normalizeVariantKey(variantKey ?? buildVariantKey({ selectedSize, selectedColor }));
	const sSize = selectedSize == null ? null : String(selectedSize).trim() || null;
	const sColor = selectedColor == null ? null : String(selectedColor).trim() || null;

	const cartId = await getOrCreateCartId(userId);
	await pool.query(
		`INSERT INTO cart_items (cart_id, product_id, quantity, selected_size, selected_color, variant_key)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (cart_id, product_id, variant_key)
		 DO UPDATE SET
			quantity = LEAST(50, cart_items.quantity + EXCLUDED.quantity),
			selected_size = EXCLUDED.selected_size,
			selected_color = EXCLUDED.selected_color,
			updated_at = now()`,
		[cartId, productId, qty, sSize, sColor, vkey]
	);
	await pool.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
}

async function setCartItemQuantity({ userId, productId, quantity, variantKey = null }) {
	if (!userId) throw new Error('userId is required');
	if (!productId) throw new Error('productId is required');
	const qty = Number(quantity);
	if (!Number.isInteger(qty) || qty < 0 || qty > 50) {
		const err = new Error('Invalid quantity');
		err.statusCode = 400;
		throw err;
	}
	const vkey = normalizeVariantKey(variantKey);
	const cartId = await getOrCreateCartId(userId);
	if (qty === 0) {
		await pool.query(`DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2 AND variant_key = $3`, [cartId, productId, vkey]);
		await pool.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
		return;
	}
	await pool.query(
		`INSERT INTO cart_items (cart_id, product_id, quantity, variant_key)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (cart_id, product_id, variant_key)
		 DO UPDATE SET
			quantity = EXCLUDED.quantity,
			updated_at = now()`,
		[cartId, productId, qty, vkey]
	);
	await pool.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
}

async function replaceCartItems({ userId, items }) {
	if (!userId) throw new Error('userId is required');
	const cartId = await getOrCreateCartId(userId);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
		for (const it of items || []) {
			const productId = String(it.productId || '').trim();
			const qty = Number(it.quantity);
			const vkey = normalizeVariantKey(it.variantKey);
			const sSize = it.selectedSize == null ? null : String(it.selectedSize).trim() || null;
			const sColor = it.selectedColor == null ? null : String(it.selectedColor).trim() || null;
			if (!productId) continue;
			if (!Number.isInteger(qty) || qty <= 0 || qty > 50) continue;
			await client.query(
				`INSERT INTO cart_items (cart_id, product_id, quantity, selected_size, selected_color, variant_key)
				 VALUES ($1, $2, $3, $4, $5, $6)`,
				[cartId, productId, qty, sSize, sColor, vkey]
			);
		}
		await client.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
		await client.query('COMMIT');
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function clearCart(userId) {
	if (!userId) return;
	const cartId = await getOrCreateCartId(userId);
	await pool.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cartId]);
	await pool.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
}

async function removeItemsFromCart({ userId, productIds }) {
	if (!userId) return;
	const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
	const ids = Array.from(
		new Set((productIds || []).map((x) => String(x || '').trim()).filter((x) => x && isUuid(x)))
	);
	if (ids.length === 0) return;
	const cartId = await getOrCreateCartId(userId);
	await pool.query(
		`DELETE FROM cart_items
		 WHERE cart_id = $1
		 AND product_id = ANY($2::uuid[])`,
		[cartId, ids]
	);
	await pool.query(`UPDATE cart SET updated_at = now() WHERE id = $1`, [cartId]);
}

function normalizeSessionCartItems(items) {
	const byKey = new Map();
	for (const it of items || []) {
		const productId = String(it.productId || '').trim();
		const vkey = normalizeVariantKey(it.variantKey);
		const quantity = Number(it.quantity);
		if (!productId) continue;
		if (!Number.isInteger(quantity) || quantity <= 0) continue;
		const key = `${productId}::${vkey}`;
		const current = byKey.get(key) || { productId, variantKey: vkey, quantity: 0, selectedSize: it.selectedSize, selectedColor: it.selectedColor };
		current.quantity += quantity;
		byKey.set(key, current);
	}
	return Array.from(byKey.values()).map((x) => ({
		productId: x.productId,
		variantKey: x.variantKey,
		selectedSize: x.selectedSize,
		selectedColor: x.selectedColor,
		quantity: Math.min(50, x.quantity),
	}));
}

async function mergeSessionCartIntoUserCart({ userId, sessionCartItems }) {
	if (!userId) return { merged: 0 };
	const normalized = normalizeSessionCartItems(sessionCartItems);
	if (normalized.length === 0) return { merged: 0 };

	for (const it of normalized) {
		await upsertCartItem({
			userId,
			productId: it.productId,
			quantity: it.quantity,
			variantKey: it.variantKey,
			selectedSize: it.selectedSize,
			selectedColor: it.selectedColor,
		});
	}
	return { merged: normalized.length };
}

module.exports = {
	listCartItems,
	countCartItems,
	upsertCartItem,
	setCartItemQuantity,
	replaceCartItems,
	clearCart,
	removeItemsFromCart,
	mergeSessionCartIntoUserCart,
	buildVariantKey,
};
