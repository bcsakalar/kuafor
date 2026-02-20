const { pool } = require('../config/db');
const { notifyLowStockCrossingAdmin } = require('../services/lowStockNotifyService');

function normalizeSlug(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';

	// Turkish-aware lowercasing first (İ/I handling)
	let s = raw.toLocaleLowerCase('tr-TR');

	// Transliterate common TR chars so they don't disappear
	s = s
		.replace(/ç/g, 'c')
		.replace(/ğ/g, 'g')
		.replace(/ı/g, 'i')
		.replace(/ö/g, 'o')
		.replace(/ş/g, 's')
		.replace(/ü/g, 'u');

	// Remove remaining diacritics (e.g., â, ê) while keeping base letters
	try {
		s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
	} catch {
		// ignore if normalize is unavailable
	}

	return s
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9\-]/g, '')
		.replace(/\-+/g, '-')
		.replace(/^\-+|\-+$/g, '');
}

async function listCategories() {
	const { rows } = await pool.query(
		`SELECT id, name, slug
		 FROM categories
		 ORDER BY name ASC`
	);
	return rows;
}

async function createCategory({ name, slug }) {
	const finalSlug = normalizeSlug(slug || name);
	const { rows } = await pool.query(
		`INSERT INTO categories (name, slug)
		 VALUES ($1, $2)
		 ON CONFLICT (slug)
		 DO UPDATE SET name = EXCLUDED.name
		 RETURNING id, name, slug`,
		[String(name || '').trim(), finalSlug]
	);
	return rows[0];
}

async function deleteCategory(id) {
	await pool.query('DELETE FROM categories WHERE id = $1', [id]);
}

function buildActiveProductsQueryParts({ categorySlug = null, minPrice = null, maxPrice = null, q = null, sort = 'newest' } = {}) {
	const params = [];
	const whereParts = ['p.is_active = true'];

	// Variant pricing support:
	// Compute min/max effective prices where each variant price falls back to product price.
	// This enables price filters and sorting to reflect variant price overrides.
	const variantPriceJoinSql = `
	LEFT JOIN LATERAL (
		SELECT
			COALESCE(MIN(COALESCE(pv.price, p.price)), p.price) AS min_price,
			COALESCE(MAX(COALESCE(pv.price, p.price)), p.price) AS max_price
		FROM product_variants pv
		WHERE pv.product_id = p.id
	) vp ON true`;

	const normalizedCategory = categorySlug ? String(categorySlug).trim().toLowerCase() : null;
	if (normalizedCategory) {
		params.push(normalizedCategory);
		whereParts.push(`c.slug = $${params.length}`);
	}

	const minRaw = minPrice === undefined || minPrice === null ? '' : String(minPrice).trim();
	const min = minRaw === '' ? NaN : Number(minRaw);
	if (Number.isFinite(min) && min >= 0) {
		params.push(min);
		// Overlap logic: include products whose max effective price is >= min.
		whereParts.push(`vp.max_price >= $${params.length}`);
	}

	const maxRaw = maxPrice === undefined || maxPrice === null ? '' : String(maxPrice).trim();
	const max = maxRaw === '' ? NaN : Number(maxRaw);
	if (Number.isFinite(max) && max >= 0) {
		params.push(max);
		// Overlap logic: include products whose min effective price is <= max.
		whereParts.push(`vp.min_price <= $${params.length}`);
	}

	const query = q ? String(q).trim() : '';
	if (query) {
		params.push(`%${query}%`);
		const ph = `$${params.length}`;
		whereParts.push(`(p.name ILIKE ${ph} OR p.description ILIKE ${ph})`);
	}

	const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

	const safeSort = String(sort || 'newest').trim().toLowerCase();
	let orderBySql = 'ORDER BY p.created_at DESC, p.name ASC';
	let salesJoinSql = '';
	let salesSelectSql = '';

	if (safeSort === 'price_asc') {
		orderBySql = 'ORDER BY vp.min_price ASC, p.created_at DESC, p.name ASC';
	} else if (safeSort === 'price_desc') {
		orderBySql = 'ORDER BY vp.max_price DESC, p.created_at DESC, p.name ASC';
	} else if (safeSort === 'best_sellers') {
		salesSelectSql = ', COALESCE(s.sold_count, 0) AS sold_count';
		salesJoinSql = `
		LEFT JOIN (
			SELECT
				oi.product_id,
				SUM(oi.quantity) AS sold_count
			FROM order_items oi
			JOIN orders o ON o.id = oi.order_id
			WHERE o.status IN ('shipped', 'completed')
			GROUP BY oi.product_id
		) s ON s.product_id = p.id`;
		orderBySql = 'ORDER BY COALESCE(s.sold_count, 0) DESC, p.created_at DESC, p.name ASC';
	}

	return { params, whereSql, variantPriceJoinSql, salesJoinSql, salesSelectSql, orderBySql };
}

async function listActiveProducts({ categorySlug = null, minPrice = null, maxPrice = null, q = null, sort = 'newest' } = {}) {
	const { params, whereSql, variantPriceJoinSql, salesJoinSql, salesSelectSql, orderBySql } = buildActiveProductsQueryParts({
		categorySlug,
		minPrice,
		maxPrice,
		q,
		sort,
	});

	const { rows } = await pool.query(
		`SELECT
			p.id,
			p.name,
			p.size,
			p.size_options,
			p.color_options,
			p.share_stock_across_colors,
			p.share_price_across_colors,
			p.description,
			p.price,
			vp.min_price,
			vp.max_price,
			(
				SELECT COALESCE(
					jsonb_object_agg(pv.variant_key, pv.price) FILTER (WHERE pv.price IS NOT NULL),
					'{}'::jsonb
				)
				FROM product_variants pv
				WHERE pv.product_id = p.id
			) AS variant_prices,
			p.stock,
			p.image_url,
			p.is_active,
			p.created_at,
			c.id AS category_id,
			c.name AS category_name,
			c.slug AS category_slug
			${salesSelectSql}
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 ${variantPriceJoinSql}
		 ${salesJoinSql}
		 ${whereSql}
		 ${orderBySql}`,
		params
	);
	return rows;
}

async function listActiveProductsPaged({
	categorySlug = null,
	minPrice = null,
	maxPrice = null,
	q = null,
	sort = 'newest',
	page = 1,
	pageSize = 12,
} = {}) {
	const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
	const safePageSize = Math.max(1, Math.min(60, Math.floor(Number(pageSize) || 12)));

	const { params, whereSql, variantPriceJoinSql, salesJoinSql, salesSelectSql, orderBySql } = buildActiveProductsQueryParts({
		categorySlug,
		minPrice,
		maxPrice,
		q,
		sort,
	});

	const countResult = await pool.query(
		`SELECT COUNT(*)::int AS total
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 ${variantPriceJoinSql}
		 ${salesJoinSql}
		 ${whereSql}`,
		params
	);
	const totalItems = Number(countResult.rows[0]?.total) || 0;
	const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
	const effectivePage = Math.min(requestedPage, totalPages);
	const offset = (effectivePage - 1) * safePageSize;

	const listParams = [...params, safePageSize, offset];
	const limitPh = `$${listParams.length - 1}`;
	const offsetPh = `$${listParams.length}`;

	const { rows: products } = await pool.query(
		`SELECT
			p.id,
			p.name,
			p.size,
			p.size_options,
			p.color_options,
			p.share_stock_across_colors,
			p.share_price_across_colors,
			p.description,
			p.price,
			vp.min_price,
			vp.max_price,
			(
				SELECT COALESCE(
					jsonb_object_agg(pv.variant_key, pv.price) FILTER (WHERE pv.price IS NOT NULL),
					'{}'::jsonb
				)
				FROM product_variants pv
				WHERE pv.product_id = p.id
			) AS variant_prices,
			p.stock,
			p.image_url,
			p.is_active,
			p.created_at,
			c.id AS category_id,
			c.name AS category_name,
			c.slug AS category_slug
			${salesSelectSql}
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 ${variantPriceJoinSql}
		 ${salesJoinSql}
		 ${whereSql}
		 ${orderBySql}
		 LIMIT ${limitPh}
		 OFFSET ${offsetPh}`,
		listParams
	);

	return {
		products,
		pagination: {
			page: effectivePage,
			pageSize: safePageSize,
			totalItems,
			totalPages,
		},
	};
}

async function listLowStockProducts({ limit = 10, onlyActive = true } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 10));
	const where = onlyActive ? 'WHERE p.is_active = true AND p.stock <= p.low_stock_threshold' : 'WHERE p.stock <= p.low_stock_threshold';
	const { rows } = await pool.query(
		`SELECT
			p.id,
			p.name,
			p.stock,
			p.low_stock_threshold,
			p.is_active,
			c.name AS category_name
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 ${where}
		 ORDER BY p.stock ASC, p.name ASC
		 LIMIT $1`,
		[lim]
	);
	return rows;
}

async function getProductById(id) {
	const { rows } = await pool.query(
		`SELECT
			p.id,
			p.name,
			p.size,
			p.size_options,
			p.color_options,
			p.share_stock_across_colors,
			p.share_price_across_colors,
			p.description,
			p.price,
			vp.min_price,
			vp.max_price,
			(
				SELECT COALESCE(
					jsonb_object_agg(pv.variant_key, pv.price) FILTER (WHERE pv.price IS NOT NULL),
					'{}'::jsonb
				)
				FROM product_variants pv
				WHERE pv.product_id = p.id
			) AS variant_prices,
			p.stock,
			p.low_stock_threshold,
			p.image_url,
			p.is_active,
			p.created_at,
			c.id AS category_id,
			c.name AS category_name,
			c.slug AS category_slug
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 LEFT JOIN LATERAL (
			SELECT
				COALESCE(MIN(COALESCE(pv.price, p.price)), p.price) AS min_price,
				COALESCE(MAX(COALESCE(pv.price, p.price)), p.price) AS max_price
			FROM product_variants pv
			WHERE pv.product_id = p.id
		) vp ON true
		 WHERE p.id = $1
		 LIMIT 1`,
		[id]
	);
	return rows[0] || null;
}

async function listProductVariantsAdmin({ productId }) {
	if (!productId) return [];
	const { rows } = await pool.query(
		`SELECT
			id,
			product_id,
			variant_key,
			selected_size,
			selected_color,
			price,
			stock,
			created_at,
			updated_at
		 FROM product_variants
		 WHERE product_id = $1
		 ORDER BY COALESCE(selected_size, ''), COALESCE(selected_color, ''), variant_key ASC`,
		[productId]
	);
	return rows;
}

async function getVariantStocksByKeys(pairs) {
	const list = Array.isArray(pairs) ? pairs : [];
	if (list.length === 0) return new Map();

	const productIds = [];
	const variantKeys = [];
	for (const p of list) {
		const pid = String(p?.productId || p?.product_id || '').trim();
		const vkey = String(p?.variantKey || p?.variant_key || '').trim();
		if (!pid || !vkey) continue;
		productIds.push(pid);
		variantKeys.push(vkey);
	}
	if (productIds.length === 0) return new Map();

	const { rows } = await pool.query(
		`WITH pairs AS (
			SELECT *
			FROM unnest($1::uuid[], $2::text[]) AS t(product_id, variant_key)
		)
		SELECT
			pv.product_id,
			pv.variant_key,
			pv.stock
		FROM product_variants pv
		JOIN pairs p
			ON p.product_id = pv.product_id
			AND p.variant_key = pv.variant_key`,
		[productIds, variantKeys]
	);
	const out = new Map();
	for (const r of rows) {
		out.set(`${r.product_id}::${r.variant_key}`, Number(r.stock) || 0);
	}
	return out;
}

async function getSharedVariantStocksBySize(pairs) {
	// For products that share stock across colors, validate availability using
	// the minimum stock across colors for the same size (or '' when no sizes).
	const list = Array.isArray(pairs) ? pairs : [];
	if (list.length === 0) return new Map();

	const productIds = [];
	const sizes = [];
	for (const p of list) {
		const pid = String(p?.productId || p?.product_id || '').trim();
		const size = p?.selectedSize == null ? '' : String(p.selectedSize);
		if (!pid) continue;
		productIds.push(pid);
		sizes.push(size);
	}
	if (productIds.length === 0) return new Map();

	const { rows } = await pool.query(
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
		[productIds, sizes]
	);

	const out = new Map();
	for (const r of rows) {
		out.set(`${r.product_id}::${String(r.selected_size || '')}`, Number(r.shared_stock) || 0);
	}
	return out;
}

async function setProductVariantsAndTotalStock({ id, variants }) {
	const productId = String(id || '').trim();
	const list = Array.isArray(variants) ? variants : [];
	if (!productId) throw new Error('Invalid product id');

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		// Lock product row to keep stock consistent.
		const { rows: productRows } = await client.query(
			`SELECT id, share_stock_across_colors
			 FROM products
			 WHERE id = $1
			 FOR UPDATE`,
			[productId]
		);
		const shareStockAcrossColors = !!productRows?.[0]?.share_stock_across_colors;

		await client.query('DELETE FROM product_variants WHERE product_id = $1', [productId]);

		// Deduplicate by variant_key (Excel may have duplicate rows); merge stock for same variant.
		const byKey = new Map();
		for (const v of list) {
			const variantKey = String(v?.variantKey || v?.variant_key || '').trim();
			if (!variantKey) continue;
			const selectedSize = v?.selectedSize == null ? null : String(v.selectedSize).trim() || null;
			const selectedColor = v?.selectedColor == null ? null : String(v.selectedColor).trim() || null;
			const priceRaw = v?.price;
			const priceNum = priceRaw === null || priceRaw === undefined || String(priceRaw).trim() === ''
				? null
				: Number(priceRaw);
			const price = Number.isFinite(priceNum) && priceNum >= 0 ? Number(priceNum) : null;
			const stock = Number.isFinite(Number(v?.stock)) ? Math.max(0, Math.floor(Number(v.stock))) : 0;
			const existing = byKey.get(variantKey);
			if (existing) {
				existing.stock += stock;
				// keep first price if current has none, else keep existing
				if (existing.price == null && price != null) existing.price = price;
			} else {
				byKey.set(variantKey, { variantKey, selectedSize, selectedColor, price, stock });
			}
		}

		let total = 0;
		const perSizeShared = new Map();
		for (const v of byKey.values()) {
			const { variantKey, selectedSize, selectedColor, price, stock } = v;
			if (shareStockAcrossColors && selectedSize) {
				const prev = perSizeShared.get(selectedSize) ?? 0;
				perSizeShared.set(selectedSize, Math.max(prev, stock));
			} else {
				total += stock;
			}
			await client.query(
				`INSERT INTO product_variants (product_id, variant_key, selected_size, selected_color, price, stock, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, now())`,
				[productId, variantKey, selectedSize, selectedColor, price, stock]
			);
		}
		if (shareStockAcrossColors) {
			for (const v of perSizeShared.values()) total += v;
		}

		await client.query(
			`UPDATE products
			 SET stock = $2
			 WHERE id = $1`,
			[productId, total]
		);

		await client.query('COMMIT');
		return { id: productId, totalStock: total };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function listProductStockEvents({ productId, limit = 50 } = {}) {
	const lim = Math.max(1, Math.min(200, Number(limit) || 50));
	const { rows } = await pool.query(
		`SELECT
			pse.id,
			pse.order_id,
			pse.delta,
			pse.reason,
			pse.created_at,
			a.full_name AS changed_by_admin_name
		 FROM product_stock_events pse
		 LEFT JOIN admins a ON a.id = pse.changed_by_admin_id
		 WHERE pse.product_id = $1
		 ORDER BY pse.created_at DESC
		 LIMIT $2`,
		[productId, lim]
	);
	return rows;
}

async function listProductsAdmin() {
	const { rows } = await pool.query(
		`SELECT
			p.id,
			p.name,
			p.size,
			p.size_options,
			p.color_options,
			p.price,
			vp.min_price,
			vp.max_price,
			p.stock,
			p.low_stock_threshold,
			p.image_url,
			p.is_active,
			p.created_at,
			c.name AS category_name,
			c.slug AS category_slug
		 FROM products p
		 LEFT JOIN categories c ON c.id = p.category_id
		 LEFT JOIN LATERAL (
			SELECT
				COALESCE(MIN(COALESCE(pv.price, p.price)), p.price) AS min_price,
				COALESCE(MAX(COALESCE(pv.price, p.price)), p.price) AS max_price
			FROM product_variants pv
			WHERE pv.product_id = p.id
		) vp ON true
		 ORDER BY p.created_at DESC, p.name ASC`
	);
	return rows;
}

async function createProduct({ name, size, sizeOptions, colorOptions, shareStockAcrossColors, sharePriceAcrossColors, description, price, stock, lowStockThreshold, imageUrl, categoryId, isActive }) {
	const { rows } = await pool.query(
		`INSERT INTO products (
			name,
			size,
			size_options,
			color_options,
			share_stock_across_colors,
			share_price_across_colors,
			description,
			price,
			stock,
			low_stock_threshold,
			image_url,
			category_id,
			is_active
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			String(name || '').trim(),
			size ? String(size).trim() : null,
			Array.isArray(sizeOptions) && sizeOptions.length ? sizeOptions : null,
			Array.isArray(colorOptions) && colorOptions.length ? colorOptions : null,
			!!shareStockAcrossColors,
			!!sharePriceAcrossColors,
			description ? String(description).trim() : null,
			Number(price),
			Number.isFinite(Number(stock)) ? Number(stock) : 0,
			Number.isFinite(Number(lowStockThreshold)) && Number(lowStockThreshold) >= 0
				? Math.floor(Number(lowStockThreshold))
				: 5,
			imageUrl ? String(imageUrl).trim() : null,
			categoryId || null,
			isActive !== false,
		]
	);
	return rows[0];
}

async function bulkUpsertProductsByName({ products, changedByAdminId = null } = {}) {
	const list = Array.isArray(products) ? products : [];
	if (list.length === 0) return { added: 0, updated: 0 };

	const variantsPending = [];
	const client = await pool.connect();
	let added = 0;
	let updated = 0;
	try {
		await client.query('BEGIN');
		for (const p of list) {
			const name = String(p?.name || '').trim();
			const price = Number(p?.price);
			const stock = Number.isFinite(Number(p?.stock)) ? Math.max(0, Math.floor(Number(p.stock))) : 0;
			const categoryId = p?.categoryId ? String(p.categoryId).trim() : null;
			const description = p?.description ? String(p.description).trim() : null;
			const incomingSizeOptions = p?.sizeOptions;
			const incomingColorOptions = p?.colorOptions;
			const sizeOptions = incomingSizeOptions === undefined
				? undefined
				: (Array.isArray(incomingSizeOptions) && incomingSizeOptions.length
					? incomingSizeOptions.map((x) => String(x).trim()).filter(Boolean)
					: null);
			const colorOptions = incomingColorOptions === undefined
				? undefined
				: (Array.isArray(incomingColorOptions) && incomingColorOptions.length
					? incomingColorOptions.map((x) => String(x).trim()).filter(Boolean)
					: null);
			const shareStockAcrossColors = !!p?.shareStockAcrossColors;
			const sharePriceAcrossColors = !!p?.sharePriceAcrossColors;
			const variants = Array.isArray(p?.variants) && p.variants.length > 0 ? p.variants : null;

			if (!name) continue;

			const { rows: existingRows } = await client.query(
				`SELECT id, stock, size, size_options, color_options
				 FROM products
				 WHERE lower(trim(name)) = lower(trim($1))
				   AND (category_id IS NOT DISTINCT FROM $2)
				 FOR UPDATE
				 LIMIT 1`,
				[name, categoryId]
			);
			const existing = existingRows[0] || null;

			if (existing) {
				const currentStock = Number(existing.stock) || 0;
				const nextSize = null;
				const nextSizeOptions = sizeOptions === undefined ? (existing.size_options ?? null) : (sizeOptions && sizeOptions.length ? Array.from(new Set(sizeOptions)) : null);
				const nextColorOptions = colorOptions === undefined ? (existing.color_options ?? null) : (colorOptions && colorOptions.length ? Array.from(new Set(colorOptions)) : null);
				await client.query(
					`UPDATE products
					 SET price = $2,
					 	 stock = $3,
					 	 description = $4,
				 	 	 category_id = $5,
				 	 	 size = $6,
					 	 size_options = $7,
					 	 color_options = $8,
					 	 share_stock_across_colors = $9,
					 	 share_price_across_colors = $10
					 WHERE id = $1`,
					[existing.id, price, stock, description, categoryId, nextSize, nextSizeOptions, nextColorOptions, shareStockAcrossColors, sharePriceAcrossColors]
				);
				const delta = stock - currentStock;
				if (delta !== 0) {
					await client.query(
						`INSERT INTO product_stock_events (product_id, order_id, delta, reason, changed_by_admin_id)
						 VALUES ($1, NULL, $2, 'manual', $3)`,
						[existing.id, delta, changedByAdminId]
					);
				}
				updated += 1;
				if (variants && variants.length > 0) {
					variantsPending.push({ productId: existing.id, variants });
				}
			} else {
				const insertSize = null;
				const insertSizeOptions = sizeOptions === undefined ? null : (sizeOptions && sizeOptions.length ? Array.from(new Set(sizeOptions)) : null);
				const insertColorOptions = colorOptions === undefined ? null : (colorOptions && colorOptions.length ? Array.from(new Set(colorOptions)) : null);
				const { rows: insertRows } = await client.query(
					`INSERT INTO products (name, size, size_options, color_options, share_stock_across_colors, share_price_across_colors, description, price, stock, category_id, is_active)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
					 RETURNING id`,
					[name, insertSize, insertSizeOptions, insertColorOptions, shareStockAcrossColors, sharePriceAcrossColors, description, price, stock, categoryId]
				);
				added += 1;
				const createdId = insertRows[0]?.id;
				if (variants && variants.length > 0 && createdId) {
					variantsPending.push({ productId: createdId, variants });
				}
			}
		}
		await client.query('COMMIT');
		for (const { productId, variants } of variantsPending) {
			await setProductVariantsAndTotalStock({ id: productId, variants });
		}
		return { added, updated };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function deleteProduct(id) {
	await pool.query('DELETE FROM products WHERE id = $1', [id]);
}

async function setProductActive({ id, isActive }) {
	await pool.query('UPDATE products SET is_active = $2 WHERE id = $1', [id, Boolean(isActive)]);
}

async function updateProductAdminFields({ id, stock, lowStockThreshold, price, imageUrl, size, sizeOptions, colorOptions, shareStockAcrossColors, sharePriceAcrossColors, variants, changedByAdminId = null }) {
	const client = await pool.connect();
	let lowStockNotify = null;
	try {
		await client.query('BEGIN');
		const { rows: currentRows } = await client.query(
			`SELECT id, name, stock, low_stock_threshold, size, size_options, color_options, share_stock_across_colors, share_price_across_colors, price, image_url
			 FROM products
			 WHERE id = $1
			 LIMIT 1
			 FOR UPDATE`,
			[id]
		);
		const current = currentRows[0] || null;
		if (!current) {
			const err = new Error('Product not found');
			err.statusCode = 404;
			throw err;
		}

		const currentStock = Number(current.stock) || 0;
		const currentThreshold = Number.isFinite(Number(current.low_stock_threshold))
			? Math.max(0, Math.floor(Number(current.low_stock_threshold)))
			: 5;
		const currentShare = !!current.share_stock_across_colors;
		const nextShare = typeof shareStockAcrossColors === 'undefined' ? currentShare : !!shareStockAcrossColors;
		const currentSharePrice = !!current.share_price_across_colors;
		const nextSharePrice = typeof sharePriceAcrossColors === 'undefined' ? currentSharePrice : !!sharePriceAcrossColors;

		let nextStock = Number.isFinite(Number(stock)) ? Math.max(0, Math.floor(Number(stock))) : currentStock;
		const nextThreshold = Number.isFinite(Number(lowStockThreshold))
			? Math.max(0, Math.floor(Number(lowStockThreshold)))
			: currentThreshold;
		// Deprecated: admin no longer manages product-level "size" label.
		const nextSize = null;
		const nextSizeOptions = sizeOptions === undefined
			? (current.size_options ?? null)
			: (Array.isArray(sizeOptions) && sizeOptions.length ? sizeOptions : null);
		const nextColorOptions = colorOptions === undefined
			? (current.color_options ?? null)
			: (Array.isArray(colorOptions) && colorOptions.length ? colorOptions : null);
		const nextPrice = price === undefined
			? (current.price === undefined ? null : current.price)
			: Number(price);
		const nextImageUrl = imageUrl === undefined
			? (current.image_url ?? null)
			: (imageUrl ? String(imageUrl).trim() : null);

		if (price !== undefined && (!Number.isFinite(Number(nextPrice)) || Number(nextPrice) < 0)) {
			const err = new Error('Invalid price');
			err.statusCode = 400;
			throw err;
		}

		// If variants are provided, replace them and sync total stock.
		if (Array.isArray(variants)) {
			await client.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
			// Deduplicate by variant_key; merge stock for same variant.
			const byKey = new Map();
			for (const v of variants) {
				const variantKey = String(v?.variantKey || v?.variant_key || '').trim();
				if (!variantKey) continue;
				const selectedSize = v?.selectedSize == null ? null : String(v.selectedSize).trim() || null;
				const selectedColor = v?.selectedColor == null ? null : String(v.selectedColor).trim() || null;
				const priceRaw = v?.price;
				const priceNum = priceRaw === null || priceRaw === undefined || String(priceRaw).trim() === ''
					? null
					: Number(priceRaw);
				const vPrice = Number.isFinite(priceNum) && priceNum >= 0 ? Number(priceNum) : null;
				const vStock = Number.isFinite(Number(v?.stock)) ? Math.max(0, Math.floor(Number(v.stock))) : 0;
				const existing = byKey.get(variantKey);
				if (existing) {
					existing.stock += vStock;
					if (existing.price == null && vPrice != null) existing.price = vPrice;
				} else {
					byKey.set(variantKey, { variantKey, selectedSize, selectedColor, price: vPrice, stock: vStock });
				}
			}
			let total = 0;
			const perSizeShared = new Map();
			for (const v of byKey.values()) {
				const { variantKey, selectedSize, selectedColor, price: vPrice, stock: vStock } = v;
				if (nextShare && selectedSize) {
					const prev = perSizeShared.get(selectedSize) ?? 0;
					perSizeShared.set(selectedSize, Math.max(prev, vStock));
				} else {
					total += vStock;
				}
				await client.query(
					`INSERT INTO product_variants (product_id, variant_key, selected_size, selected_color, price, stock, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, now())`,
					[id, variantKey, selectedSize, selectedColor, vPrice, vStock]
				);
			}
			if (nextShare) {
				for (const v of perSizeShared.values()) total += v;
			}
			const hasOptions = (Array.isArray(nextSizeOptions) && nextSizeOptions.length > 0)
				|| (Array.isArray(nextColorOptions) && nextColorOptions.length > 0);
			if (hasOptions) nextStock = total;
		}

		await client.query(
			`UPDATE products
			 SET stock = $2,
		 	 	 low_stock_threshold = $3,
		 	 	 size = $4,
		 		 size_options = $5,
		 		 color_options = $6,
		 		 share_stock_across_colors = $7,
		 		 share_price_across_colors = $8,
		 		 price = $9,
		 		 image_url = $10
			 WHERE id = $1`,
			[id, nextStock, nextThreshold, nextSize, nextSizeOptions, nextColorOptions, nextShare, nextSharePrice, nextPrice, nextImageUrl]
		);

		const delta = nextStock - currentStock;
		if (delta !== 0) {
			await client.query(
				`INSERT INTO product_stock_events (product_id, order_id, delta, reason, changed_by_admin_id)
				 VALUES ($1, NULL, $2, 'manual', $3)`,
				[id, delta, changedByAdminId]
			);
		}

		const wasLow = currentStock <= currentThreshold;
		const isLow = nextStock <= nextThreshold;
		if (!wasLow && isLow) {
			lowStockNotify = {
				productId: String(current.id),
				productName: String(current.name || '').trim() || null,
				stock: nextStock,
				threshold: nextThreshold,
			};
		}

		await client.query('COMMIT');

		if (lowStockNotify) {
			// Fire-and-forget: avoid blocking UI on email transport.
			setImmediate(() => {
				Promise.resolve(notifyLowStockCrossingAdmin(lowStockNotify)).catch(() => {});
			});
		}

		return {
			id,
			stock: nextStock,
			lowStockThreshold: nextThreshold,
			size: nextSize,
			price: nextPrice,
			imageUrl: nextImageUrl,
		};
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

async function adjustProductStock({ id, delta, changedByAdminId = null }) {
	const d = Number(delta);
	if (!Number.isFinite(d) || d === 0) {
		const err = new Error('Invalid delta');
		err.statusCode = 400;
		throw err;
	}

	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const { rows: currentRows } = await client.query(
			`SELECT id, name, stock, low_stock_threshold
			 FROM products
			 WHERE id = $1
			 FOR UPDATE`,
			[id]
		);
		const current = currentRows[0] || null;
		if (!current) {
			const err = new Error('Product not found');
			err.statusCode = 404;
			throw err;
		}

		const currentStock = Number(current.stock) || 0;
		const threshold = Number.isFinite(Number(current.low_stock_threshold))
			? Math.max(0, Math.floor(Number(current.low_stock_threshold)))
			: 5;
		const nextStock = Math.max(0, currentStock + Math.trunc(d));
		const appliedDelta = nextStock - currentStock;
		if (appliedDelta !== 0) {
			await client.query(
				`UPDATE products
				 SET stock = $2
				 WHERE id = $1`,
				[id, nextStock]
			);
			await client.query(
				`INSERT INTO product_stock_events (product_id, order_id, delta, reason, changed_by_admin_id)
				 VALUES ($1, NULL, $2, 'manual', $3)`,
				[id, appliedDelta, changedByAdminId]
			);
		}

		await client.query('COMMIT');

		const wasLow = currentStock <= threshold;
		const isLow = nextStock <= threshold;
		if (!wasLow && isLow) {
			setImmediate(() => {
				Promise.resolve(notifyLowStockCrossingAdmin({
					productId: String(current.id),
					productName: String(current.name || '').trim() || null,
					stock: nextStock,
					threshold,
				})).catch(() => {});
			});
		}

		return { id, stock: nextStock, appliedDelta };
	} catch (err) {
		try { await client.query('ROLLBACK'); } catch { /* ignore */ }
		throw err;
	} finally {
		client.release();
	}
}

module.exports = {
	listCategories,
	createCategory,
	deleteCategory,
	listActiveProducts,
	listActiveProductsPaged,
	listLowStockProducts,
	getProductById,
	listProductVariantsAdmin,
	getVariantStocksByKeys,
	getSharedVariantStocksBySize,
	listProductStockEvents,
	listProductsAdmin,
	createProduct,
	setProductVariantsAndTotalStock,
	bulkUpsertProductsByName,
	deleteProduct,
	setProductActive,
	updateProductAdminFields,
	adjustProductStock,
};
