const shopModel = require('../models/shopModel');
const orderModel = require('../models/orderModel');
const cartModel = require('../models/cartModel');
const cancellationRequestModel = require('../models/cancellationRequestModel');
const shopContactModel = require('../models/shopContactModel');
const { logger } = require('../config/logger');
const { getTemplate, sendEmail } = require('../services/emailService');
const { getContactNotifyToEmail, getShopNotifyToEmail } = require('../config/email');
const socketService = require('../services/socketService');
const { getAppBaseUrl, getShopBaseUrl } = require('../utils/appBaseUrl');
const {
	createCheckoutForm,
	checkoutFormInitialize,
	ensureResponsiveCheckoutFormContent,
	extractIyzicoError,
} = require('../services/iyzicoPaymentService');
const { finalizeOrder } = require('../services/orderService');
const { paymentStatusLabelTR, orderStatusLabelTR } = require('../utils/statusLabels');

function normalizeOptionArray(value) {
	if (!Array.isArray(value)) return [];
	return value
		.map((x) => (x == null ? '' : String(x)).trim())
		.filter(Boolean);
}

function buildVariantKey({ selectedSize = '', selectedColor = '' } = {}) {
	const s = selectedSize == null ? '' : String(selectedSize);
	const c = selectedColor == null ? '' : String(selectedColor);
	return JSON.stringify([s, c]);
}

function normalizeVariantKey(value) {
	const raw = value == null ? '' : String(value);
	if (!raw.trim()) return buildVariantKey({ selectedSize: '', selectedColor: '' });
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.length === 2) {
			return buildVariantKey({ selectedSize: parsed[0] ?? '', selectedColor: parsed[1] ?? '' });
		}
	} catch {
		// ignore
	}
	return raw;
}

function normalizeVariantSelection({ product, selectedSizeRaw, selectedColorRaw }) {
	const sizeOptions = normalizeOptionArray(product?.size_options);
	const colorOptions = normalizeOptionArray(product?.color_options);

	let selectedSize = selectedSizeRaw == null ? '' : String(selectedSizeRaw).trim();
	let selectedColor = selectedColorRaw == null ? '' : String(selectedColorRaw).trim();

	if (!selectedSize && sizeOptions.length === 1) selectedSize = sizeOptions[0];
	if (!selectedColor && colorOptions.length === 1) selectedColor = colorOptions[0];

	if (sizeOptions.length > 1 && !selectedSize) return { ok: false, code: 'MISSING_SIZE' };
	if (colorOptions.length > 1 && !selectedColor) return { ok: false, code: 'MISSING_COLOR' };

	if (selectedSize && sizeOptions.length > 0 && !sizeOptions.includes(selectedSize)) return { ok: false, code: 'INVALID_SIZE' };
	if (selectedColor && colorOptions.length > 0 && !colorOptions.includes(selectedColor)) return { ok: false, code: 'INVALID_COLOR' };

	if (sizeOptions.length === 0) selectedSize = '';
	if (colorOptions.length === 0) selectedColor = '';

	return {
		ok: true,
		selectedSize,
		selectedColor,
		variantKey: buildVariantKey({ selectedSize, selectedColor }),
	};
}

function splitNameTR(fullName) {
	const raw = String(fullName || '').trim();
	if (!raw) return { name: 'Müşteri', surname: '.' };
	const parts = raw.split(/\s+/).filter(Boolean);
	if (parts.length === 1) return { name: parts[0], surname: '.' };
	return { name: parts[0], surname: parts.slice(1).join(' ') };
}

function getClientIp(req) {
	const xff = String(req.headers['x-forwarded-for'] || '').trim();
	if (xff) return xff.split(',')[0].trim();
	const realIp = String(req.headers['x-real-ip'] || '').trim();
	if (realIp) return realIp;
	const ip = String(req.ip || '').trim();
	if (!ip) return '';
	return ip.replace(/^::ffff:/, '');
}

function sendTopRedirect(res, targetUrl) {
	const safeTarget = String(targetUrl || '/').trim() || '/';
	const escaped = safeTarget.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return res
		.status(200)
		.set('Content-Type', 'text/html; charset=utf-8')
		.send(
			`<!doctype html>
<html lang="tr">
<head>
	<meta charset="utf-8" />
	<meta http-equiv="refresh" content="0; url=${escaped}" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Yönlendiriliyor...</title>
</head>
<body>
	<script>
		(function () {
			var url = ${JSON.stringify(safeTarget)};
			try {
				window.top.location.href = url;
			} catch (e) {
				window.location.href = url;
			}
		})();
	</script>
	<p>Yönlendiriliyor... <a href="${escaped}">Devam</a></p>
</body>
</html>`
		);
}

function isSafeInternalRedirect(targetUrl) {
	const raw = String(targetUrl || '').trim();
	if (!raw) return false;
	if (!raw.startsWith('/')) return false;
	// Prevent protocol-relative URLs and obvious open-redirect patterns.
	if (raw.startsWith('//')) return false;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return false;
	return true;
}

function isSafeIyzicoRedirectUrl(targetUrl) {
	const raw = String(targetUrl || '').trim();
	if (!raw) return false;
	try {
		const u = new URL(raw);
		if (String(u.protocol || '').toLowerCase() !== 'https:') return false;
		const host = String(u.hostname || '').trim().toLowerCase();
		if (!host) return false;
		// Allow only iyzico/iyzipay hosted payment pages (sandbox and production).
		if (host === 'iyzipay.com' || host.endsWith('.iyzipay.com')) return true;
		if (host === 'iyzico.com' || host.endsWith('.iyzico.com')) return true;
		return false;
	} catch {
		return false;
	}
}

function pickIyzicoPaymentPageUrl(initializeResult) {
	const r = initializeResult || {};
	// Docs: CF returns paymentPageUrl; keep a couple of fallbacks for SDK naming quirks.
	return String(r.paymentPageUrl || r.paymentPageURL || r.payWithIyzicoPageUrl || '').trim();
}

function isLikelyMobileRequest(req) {
	const q = req && req.query ? req.query : null;
	if (q && (q.mobile === '1' || q.mobile === 'true')) return true;
	const ua = String(req?.headers?.['user-agent'] || '').toLowerCase();
	if (!ua) return false;
	return /iphone|ipad|ipod|android|mobile|windows phone|webos|blackberry|opera mini|iemobile/.test(ua);
}

function isExplicitJsonRequest(req) {
	const q = req && req.query ? req.query : null;
	if (q && String(q.format || '').toLowerCase() === 'json') return true;
	// For mobile apps calling our API, require an explicit JSON accept header.
	const accept = String(req?.headers?.accept || '').toLowerCase();
	if (accept.includes('application/json')) return true;
	// Support explicit body flags (some clients use form posts).
	const rt = String(req?.body?.responseType || req?.body?.response_type || '').toLowerCase();
	if (rt === 'json') return true;
	const api = String(req?.body?.api || '').toLowerCase();
	if (api === '1' || api === 'true') return true;
	return false;
}

function buildRedirectUrl({ to, mode, orderId } = {}) {
	const qs = new URLSearchParams();
	if (mode) qs.set('mode', String(mode));
	if (orderId) qs.set('orderId', String(orderId));
	qs.set('to', String(to || '/'));
	return `/payment-redirect?${qs.toString()}`;
}


function getCart(req) {
	if (!req.session) return { items: [] };
	if (!req.session.cart || typeof req.session.cart !== 'object') req.session.cart = { items: [] };
	if (!Array.isArray(req.session.cart.items)) req.session.cart.items = [];
	return req.session.cart;
}

function normalizeCartItems(items) {
	const byKey = new Map();
	for (const it of items || []) {
		const productId = String(it.productId || '').trim();
		const rawVariantKey = it.variantKey == null ? '' : String(it.variantKey);
		let variantKey = normalizeVariantKey(rawVariantKey);
		// Back-compat: older DB rows may have variant_key='' but still store selected_size/selected_color.
		// If we have an explicit selection, rebuild the canonical key from the selections to avoid
		// collapsing different variants into one cart line.
		if (!rawVariantKey.trim()) {
			const hasSize = it.selectedSize != null && String(it.selectedSize).trim() !== '';
			const hasColor = it.selectedColor != null && String(it.selectedColor).trim() !== '';
			if (hasSize || hasColor) {
				variantKey = buildVariantKey({ selectedSize: it.selectedSize, selectedColor: it.selectedColor });
			}
		}
		const quantity = Number(it.quantity);
		if (!productId) continue;
		if (!Number.isInteger(quantity) || quantity <= 0) continue;
		const key = `${productId}::${variantKey}`;
		const current = byKey.get(key) || {
			productId,
			variantKey,
			selectedSize: it.selectedSize,
			selectedColor: it.selectedColor,
			quantity: 0,
		};
		current.quantity += quantity;
		byKey.set(key, current);
	}
	return Array.from(byKey.values()).map((x) => ({
		productId: x.productId,
		variantKey: x.variantKey,
		selectedSize: x.selectedSize,
		selectedColor: x.selectedColor,
		quantity: x.quantity,
	}));
}

async function buildCartSummary(req) {
	let normalized = [];
	if (req.shopUser && req.shopUser.id) {
		const dbItems = await cartModel.listCartItems(req.shopUser.id);
		normalized = normalizeCartItems((dbItems || []).map((x) => ({
			productId: x.product_id,
			quantity: x.quantity,
			variantKey: x.variant_key,
			selectedSize: x.selected_size,
			selectedColor: x.selected_color,
		})));
	} else {
		const cart = getCart(req);
		normalized = normalizeCartItems(cart.items);
	}
	if (normalized.length === 0) {
		return { normalized, lines: [], total: 0, cartCount: 0 };
	}

	const products = await Promise.all(normalized.map((it) => shopModel.getProductById(it.productId)));

	// Batch-load variant stocks for items that have selectable options.
	const variantPairs = [];
	const sharedSizePairs = [];
	for (let idx = 0; idx < normalized.length; idx++) {
		const it = normalized[idx];
		const p = products[idx];
		if (!p || p.is_active !== true) continue;
		const sel = normalizeVariantSelection({
			product: p,
			selectedSizeRaw: it.selectedSize,
			selectedColorRaw: it.selectedColor,
		});
		if (!sel.ok) continue;
		const hasOptions = (Array.isArray(p.size_options) && p.size_options.length > 0)
			|| (Array.isArray(p.color_options) && p.color_options.length > 0);
		if (hasOptions) {
			variantPairs.push({ productId: p.id, variantKey: sel.variantKey });
			if (p.share_stock_across_colors) {
				sharedSizePairs.push({ productId: p.id, selectedSize: sel.selectedSize || '' });
			}
		}
	}
	const variantStockMap = await shopModel.getVariantStocksByKeys(variantPairs);
	const sharedStockBySizeMap = await shopModel.getSharedVariantStocksBySize(sharedSizePairs);

	const lines = normalized
		.map((it, idx) => {
			const p = products[idx];
			if (!p || p.is_active !== true) return null;
			const sel = normalizeVariantSelection({
				product: p,
				selectedSizeRaw: it.selectedSize,
				selectedColorRaw: it.selectedColor,
			});
			if (!sel.ok) return null;

			const key = `${p.id}::${sel.variantKey}`;
			const hasOptions = (Array.isArray(p.size_options) && p.size_options.length > 0)
				|| (Array.isArray(p.color_options) && p.color_options.length > 0);
			const fallback = Math.max(0, Number(p.stock) || 0);
			const sizeKey = `${p.id}::${String(sel.selectedSize || '')}`;
			const available = hasOptions
				? (p.share_stock_across_colors && sharedStockBySizeMap.has(sizeKey)
					? Math.max(0, Number(sharedStockBySizeMap.get(sizeKey)) || 0)
					: (variantStockMap.has(key) ? Math.max(0, Number(variantStockMap.get(key)) || 0) : fallback))
				: fallback;

			const qty = Math.min(it.quantity, available);
			if (qty <= 0) return null;
			const basePrice = Number(p.price);
			const overrideRaw = p && p.variant_prices && typeof p.variant_prices === 'object'
				? p.variant_prices[sel.variantKey]
				: undefined;
			const overrideNum = overrideRaw === undefined || overrideRaw === null ? NaN : Number(overrideRaw);
			const unitPrice = Number.isFinite(overrideNum) && overrideNum >= 0 ? overrideNum : basePrice;
			return {
				product: p,
				quantity: qty,
				variantKey: sel.variantKey,
				selectedSize: sel.selectedSize || null,
				selectedColor: sel.selectedColor || null,
				unitPrice,
				lineTotal: unitPrice * qty,
			};
		})
		.filter(Boolean);

	// Persist trimmed quantities back (best-effort)
	try {
		const trimmed = lines.map((l) => ({
			productId: l.product.id,
			quantity: l.quantity,
			variantKey: l.variantKey,
			selectedSize: l.selectedSize,
			selectedColor: l.selectedColor,
		}));
		if (req.shopUser && req.shopUser.id) {
			await cartModel.replaceCartItems({ userId: req.shopUser.id, items: trimmed });
		} else {
			req.session.cart.items = trimmed;
		}
	} catch {
		// ignore
	}

	const cartCount = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
	const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
	return { normalized, lines, total, cartCount };
}

async function getCartCount(req) {
	if (req.shopUser && req.shopUser.id) {
		return cartModel.countCartItems(req.shopUser.id);
	}
	return getCart(req).items.reduce((sum, x) => sum + (Number(x.quantity) || 0), 0);
}

function parseProductListQuery(query) {
	const category = query.category ? String(query.category).trim() : '';
	const q = query.q ? String(query.q).trim() : '';
	const sort = query.sort ? String(query.sort).trim() : 'newest';
	let minPrice = query.minPrice;
	let maxPrice = query.maxPrice;
	if (typeof minPrice === 'string' && minPrice.trim() === '') minPrice = null;
	if (typeof maxPrice === 'string' && maxPrice.trim() === '') maxPrice = null;

	const minN = Number(minPrice);
	const maxN = Number(maxPrice);
	if (Number.isFinite(minN) && Number.isFinite(maxN) && minN >= 0 && maxN >= 0 && minN > maxN) {
		minPrice = String(maxN);
		maxPrice = String(minN);
	}

	const pageRaw = query.page;
	const page = Math.max(1, Math.floor(Number(pageRaw) || 1));

	return {
		category,
		q,
		sort,
		minPrice: minPrice ?? null,
		maxPrice: maxPrice ?? null,
		page,
		filters: {
			category: category || '',
			q: q || '',
			minPrice: typeof minPrice === 'string' ? minPrice : (minPrice == null ? '' : String(minPrice)),
			maxPrice: typeof maxPrice === 'string' ? maxPrice : (maxPrice == null ? '' : String(maxPrice)),
			sort: sort || 'newest',
		},
	};
}

function buildPageHrefFactory({ basePath, query }) {
	return (pageNumber) => {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query || {})) {
			if (v === undefined || v === null) continue;
			if (k === 'page') continue;
			const s = String(v);
			if (s.trim() === '') continue;
			params.set(k, s);
		}
		const p = Math.max(1, Math.floor(Number(pageNumber) || 1));
		if (p > 1) params.set('page', String(p));
		const qs = params.toString();
		return qs ? `${basePath}?${qs}` : basePath;
	};
}

async function renderShopHome(req, res, next) {
	try {
		const parsed = parseProductListQuery(req.query);
		const [categories, paged] = await Promise.all([
			shopModel.listCategories(),
			shopModel.listActiveProductsPaged({
				categorySlug: parsed.category || null,
				minPrice: parsed.minPrice,
				maxPrice: parsed.maxPrice,
				q: parsed.q || null,
				sort: parsed.sort || 'newest',
				page: parsed.page,
				pageSize: 12,
			}),
		]);
		res.render('shop/home', {
			title: 'Mağaza',
			layout: 'layouts/shop',
			categories,
			products: paged.products,
			pagination: paged.pagination,
			buildPageHref: buildPageHrefFactory({ basePath: '/', query: req.query }),
			activeCategory: parsed.category || null,
			filters: parsed.filters,
			searchPath: '/',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderShopProducts(req, res, next) {
	try {
		const parsed = parseProductListQuery(req.query);
		const [categories, paged] = await Promise.all([
			shopModel.listCategories(),
			shopModel.listActiveProductsPaged({
				categorySlug: parsed.category || null,
				minPrice: parsed.minPrice,
				maxPrice: parsed.maxPrice,
				q: parsed.q || null,
				sort: parsed.sort || 'newest',
				page: parsed.page,
				pageSize: 12,
			}),
		]);

		res.render('shop/products', {
			title: 'Ürünler',
			layout: 'layouts/shop',
			categories,
			products: paged.products,
			pagination: paged.pagination,
			buildPageHref: buildPageHrefFactory({ basePath: '/products', query: req.query }),
			filters: parsed.filters,
			searchPath: '/products',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderProduct(req, res, next) {
	try {
		const product = await shopModel.getProductById(req.params.id);
		if (!product || product.is_active !== true) {
			return res.status(404).render('pages/404', { title: 'Ürün Bulunamadı', layout: 'layouts/shop' });
		}
		res.render('shop/product', {
			title: product.name,
			layout: 'layouts/shop',
			product,
			query: req.query,
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderCart(req, res, next) {
	try {
		const { normalized, lines, total, cartCount } = await buildCartSummary(req);

		res.render('shop/cart', {
			title: 'Sepet',
			layout: 'layouts/shop',
			lines,
			total,
			cartCount,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function addToCart(req, res, next) {
	try {
		const productId = String(req.body.productId || '').trim();
		const qty = Number(req.body.quantity || 1);
		const selectedSizeRaw = req.body.selected_size;
		const selectedColorRaw = req.body.selected_color;
		if (!productId || !Number.isInteger(qty) || qty <= 0 || qty > 50) {
			return res.redirect('/cart?error=1');
		}

		const product = await shopModel.getProductById(productId);
		if (!product || product.is_active !== true) {
			return res.redirect('/cart?error=1');
		}
		const sel = normalizeVariantSelection({ product, selectedSizeRaw, selectedColorRaw });
		if (!sel.ok) {
			return res.redirect(`/product/${encodeURIComponent(productId)}?variant_error=${encodeURIComponent(sel.code || '1')}`);
		}
		const hasOptions = (Array.isArray(product.size_options) && product.size_options.length > 0)
			|| (Array.isArray(product.color_options) && product.color_options.length > 0);
		let available = Math.max(0, Number(product.stock) || 0);
		if (hasOptions) {
			if (product.share_stock_across_colors) {
				const sm = await shopModel.getSharedVariantStocksBySize([{ productId: product.id, selectedSize: sel.selectedSize || '' }]);
				const sk = `${product.id}::${String(sel.selectedSize || '')}`;
				if (sm.has(sk)) available = Math.max(0, Number(sm.get(sk)) || 0);
			} else {
				const m = await shopModel.getVariantStocksByKeys([{ productId: product.id, variantKey: sel.variantKey }]);
				const k = `${product.id}::${sel.variantKey}`;
				if (m.has(k)) available = Math.max(0, Number(m.get(k)) || 0);
			}
		}
		if (available <= 0 || qty > available) {
			return res.redirect('/cart?error=1');
		}

		if (req.shopUser && req.shopUser.id) {
			await cartModel.upsertCartItem({
				userId: req.shopUser.id,
				productId,
				quantity: qty,
				variantKey: sel.variantKey,
				selectedSize: sel.selectedSize,
				selectedColor: sel.selectedColor,
			});
			return res.redirect('/cart?ok=1');
		}

		const cart = getCart(req);
		const items = Array.isArray(cart.items) ? cart.items : [];
		const existingQty = items
			.filter((x) => String(x.productId) === productId && normalizeVariantKey(x.variantKey) === sel.variantKey)
			.reduce((sum, x) => sum + (Number(x.quantity) || 0), 0);
		const nextQty = Math.min(50, Math.max(1, existingQty + qty));
		const cappedQty = Math.min(nextQty, available);
		cart.items = items.filter((x) => !(String(x.productId) === productId && normalizeVariantKey(x.variantKey) === sel.variantKey));
		if (cappedQty > 0) cart.items.push({ productId, quantity: cappedQty, variantKey: sel.variantKey, selectedSize: sel.selectedSize, selectedColor: sel.selectedColor });
		res.redirect('/cart?ok=1');
	} catch (err) {
		next(err);
	}
}

async function removeFromCart(req, res) {
	const productId = String(req.body.productId || '').trim();
	const variantKey = normalizeVariantKey(req.body.variant_key);
	if (req.shopUser && req.shopUser.id) {
		try {
			await cartModel.setCartItemQuantity({ userId: req.shopUser.id, productId, variantKey, quantity: 0 });
			return res.redirect('/cart?ok=1');
		} catch {
			return res.redirect('/cart?error=1');
		}
	}
	const cart = getCart(req);
	cart.items = (cart.items || []).filter((x) => !(String(x.productId) === productId && normalizeVariantKey(x.variantKey) === variantKey));
	res.redirect('/cart?ok=1');
}

async function updateCartItem(req, res, next) {
	try {
		const productId = String(req.body.productId || '').trim();
		const variantKey = normalizeVariantKey(req.body.variant_key);
		const qty = Number(req.body.quantity);
		if (!productId || !Number.isInteger(qty) || qty < 1 || qty > 50) {
			return res.redirect('/cart?error=1');
		}

		const product = await shopModel.getProductById(productId);
		if (!product || product.is_active !== true) return res.redirect('/cart?error=1');
		const hasOptions = (Array.isArray(product.size_options) && product.size_options.length > 0)
			|| (Array.isArray(product.color_options) && product.color_options.length > 0);
		let maxStock = Math.max(0, Number(product.stock) || 0);
		if (hasOptions) {
			if (product.share_stock_across_colors) {
				// When stock is shared across colors, validate by size pool (min across colors).
				// In this route we only receive variantKey, so parse size from the JSON format.
				let selectedSize = '';
				try {
					const parsed = JSON.parse(String(variantKey || ''));
					if (Array.isArray(parsed) && parsed.length === 2) selectedSize = String(parsed[0] ?? '');
				} catch {
					// ignore
				}
				const sm = await shopModel.getSharedVariantStocksBySize([{ productId: product.id, selectedSize }]);
				const sk = `${product.id}::${String(selectedSize || '')}`;
				if (sm.has(sk)) maxStock = Math.max(0, Number(sm.get(sk)) || 0);
			} else {
				const m = await shopModel.getVariantStocksByKeys([{ productId: product.id, variantKey }]);
				const k = `${product.id}::${variantKey}`;
				if (m.has(k)) maxStock = Math.max(0, Number(m.get(k)) || 0);
			}
		}
		const safeQty = Math.min(qty, maxStock);
		if (safeQty <= 0) return res.redirect('/cart?error=1');

		if (req.shopUser && req.shopUser.id) {
			await cartModel.setCartItemQuantity({ userId: req.shopUser.id, productId, variantKey, quantity: safeQty });
			return res.redirect('/cart?ok=1');
		}

		const cart = getCart(req);
		const items = Array.isArray(cart.items) ? cart.items : [];
		const existing = items.find((x) => String(x.productId) === productId && normalizeVariantKey(x.variantKey) === variantKey);
		const filtered = items.filter((x) => !(String(x.productId) === productId && normalizeVariantKey(x.variantKey) === variantKey));
		filtered.push({
			productId,
			quantity: safeQty,
			variantKey,
			selectedSize: existing && existing.selectedSize ? existing.selectedSize : undefined,
			selectedColor: existing && existing.selectedColor ? existing.selectedColor : undefined,
		});
		cart.items = filtered;
		return res.redirect('/cart?ok=1');
	} catch (err) {
		next(err);
	}
}

async function renderCheckout(req, res, next) {
	try {
		const { normalized, lines, total, cartCount } = await buildCartSummary(req);
		if (normalized.length === 0) return res.redirect('/cart');

		res.render('shop/checkout', {
			title: 'Ödeme',
			layout: 'layouts/shop',
			cartCount,
			lines,
			total,
			query: req.query,
			checkoutFormContent: null,
			paymentToken: null,
			paymentOrderId: null,
			paymentError: null,
		});
	} catch (err) {
		next(err);
	}
}

async function placeOrder(req, res, next) {
	try {
		const wantsJson = isExplicitJsonRequest(req);
		const redirectCheckoutError = (reason, errorId) => {
			const allowed = new Set(['contract', 'kvkk', 'address', 'name', 'phone', 'cart', 'stock', 'variant', 'product', 'server']);
			const r = allowed.has(String(reason || '')) ? String(reason) : 'server';
			if (wantsJson) {
				return res.status(400).json({ ok: false, error: 'checkout_validation', reason: r, errorId: errorId ? String(errorId) : null });
			}
			const qs = new URLSearchParams();
			qs.set('error', '1');
			qs.set('reason', r);
			if (errorId) qs.set('errorId', String(errorId));
			return res.redirect(`/checkout?${qs.toString()}`);
		};

		const { lines, total, cartCount } = await buildCartSummary(req);
		const normalized = (lines || []).map((l) => ({
			productId: l.product.id,
			quantity: l.quantity,
			variantKey: l.variantKey,
			selectedSize: l.selectedSize,
			selectedColor: l.selectedColor,
		}));
		if (normalized.length === 0) return redirectCheckoutError('cart');

		const contractApproval = String(req.body.contractApproval || '').trim();
		const legacyLegalApproval = String(req.body.legalApproval || '').trim();
		const isApproved = (
			contractApproval === 'on' || contractApproval === 'true' || contractApproval === '1'
			|| legacyLegalApproval === 'on' || legacyLegalApproval === 'true' || legacyLegalApproval === '1'
		);
		if (!isApproved) {
			return redirectCheckoutError('contract');
		}

		const kvkkNotice = String(req.body.kvkkNotice || '').trim();
		const isKvkkNoticed = (kvkkNotice === 'on' || kvkkNotice === 'true' || kvkkNotice === '1');
		if (!isKvkkNoticed) {
			return redirectCheckoutError('kvkk');
		}

		const shippingAddress = String(req.body.shippingAddress || '').trim();
		const isLoggedIn = Boolean(req.shopUser && req.shopUser.id);
		const fullName = isLoggedIn
			? (String(req.shopUser.full_name || '').trim() || String(req.body.fullName || '').trim())
			: String(req.body.fullName || '').trim();
		const phone = isLoggedIn
			? (String(req.shopUser.phone || '').trim() || String(req.body.phone || '').trim())
			: String(req.body.phone || '').trim();
		const email = isLoggedIn
			? (String(req.shopUser.email || '').trim() || String(req.body.email || '').trim())
			: String(req.body.email || '').trim();

		if (!shippingAddress) return redirectCheckoutError('address');
		if (!fullName) return redirectCheckoutError('name');
		if (!phone) return redirectCheckoutError('phone');

		// IMPORTANT: for shop accounts, do not key customer identity by phone.
		// Multiple accounts can share a phone, and phone-based dedupe can mix order ownership.
		// We store contact details on the order itself; customer record is best-effort (email-only).
		const customerId = await orderModel.upsertCustomer({ fullName, phone: null, email });
		const result = await orderModel.createOrderFromCart({
			userId: customerId,
			shopUserId: req.shopUser && req.shopUser.id ? req.shopUser.id : null,
			shippingAddress,
			cartItems: normalized,
			customerFullName: fullName,
			customerPhone: phone,
			customerEmail: email,
		});

		const orderId = result.orderId;
		const totalAmount = Number(result.totalAmount) || Number(total) || 0;
		const buyerName = splitNameTR(fullName);
		const shopBaseUrl = getShopBaseUrl(req) || getAppBaseUrl(req);

		const payMode = String(req.body.payMode || '').trim().toLowerCase();
		const wantsRedirect = payMode === 'redirect' || payMode === 'mobile' || (payMode === 'auto' && isLikelyMobileRequest(req));
		if (payMode === 'hosted') {
			if (wantsJson) {
				return res.status(200).json({ ok: true, mode: 'hosted', orderId: String(orderId) });
			}
			return res
				.status(303)
				.redirect(buildRedirectUrl({
					to: `/checkout/hosted?orderId=${encodeURIComponent(String(orderId))}`,
					orderId: String(orderId),
					mode: 'pay',
				}));
		}

		let checkoutPayload;
		try {
			const cbBase = String(shopBaseUrl || '').replace(/\/+$/, '');
			const cbUrl = `${cbBase}/payment-callback?orderId=${encodeURIComponent(String(orderId))}`;
			checkoutPayload = createCheckoutForm({
				cartItems: (lines || []).map((l) => ({
					id: String(l.product.id),
					name: String(l.product.name || 'Ürün'),
					category1: String(l.product.category_name || l.product.category || 'Shop'),
					unitPrice: l.unitPrice,
					quantity: l.quantity,
				})),
				buyer: {
					id: String(customerId || orderId),
					name: buyerName.name,
					surname: buyerName.surname,
					gsmNumber: String(phone),
					email: String(email || '').trim() || 'no-reply@example.com',
					identityNumber: String(process.env.IYZICO_DEFAULT_IDENTITY_NUMBER || '11111111111'),
					registrationAddress: String(shippingAddress),
					ip: getClientIp(req),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
				},
				shippingAddress: {
					contactName: String(fullName),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
					address: String(shippingAddress),
					zipCode: String(process.env.IYZICO_DEFAULT_ZIP || '00000'),
				},
				billingAddress: {
					contactName: String(fullName),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
					address: String(shippingAddress),
					zipCode: String(process.env.IYZICO_DEFAULT_ZIP || '00000'),
				},
				conversationId: String(orderId),
				basketId: String(orderId),
				price: totalAmount,
				paidPrice: totalAmount,
				callbackUrl: cbUrl,
				callbackBaseUrl: shopBaseUrl,
			});
		} catch (err) {
			return redirectCheckoutError('server');
		}

		const initialize = await checkoutFormInitialize(checkoutPayload);
		if (!initialize || String(initialize.status || '').toLowerCase() !== 'success') {
			if (wantsJson) {
				return res.status(502).json({
					ok: false,
					error: 'iyzico_initialize_failed',
					message: String(initialize?.errorMessage || 'Ödeme başlatılamadı'),
					orderId: String(orderId),
				});
			}
			try {
				const e = extractIyzicoError(initialize);
				await orderModel.setOrderPaymentFailureDetails({
					orderId,
					errorCode: e.errorCode,
					errorMessage: e.errorMessage,
					errorGroup: e.errorGroup,
					raw: e.raw,
				});
			} catch {
				// ignore
			}
			return res.render('shop/checkout', {
				title: 'Ödeme',
				layout: 'layouts/shop',
				cartCount,
				lines,
				total,
				query: req.query,
				checkoutFormContent: null,
				paymentToken: null,
				paymentOrderId: orderId,
				paymentError: String(initialize?.errorMessage || 'Ödeme başlatılamadı'),
			});
		}

		const token = String(initialize.token || '').trim();
		const checkoutFormContent = ensureResponsiveCheckoutFormContent(initialize.checkoutFormContent || '');
		const paymentPageUrl = pickIyzicoPaymentPageUrl(initialize);
		if (token) {
			await orderModel.setOrderPaymentInit({ orderId, paymentToken: token });
		}

		if (wantsJson) {
			return res.status(200).json({
				ok: true,
				mode: wantsRedirect ? 'redirect' : 'embed',
				orderId: String(orderId),
				token: token || null,
				paymentPageUrl: isSafeIyzicoRedirectUrl(paymentPageUrl) ? paymentPageUrl : null,
			});
		}

		// Mobile flow: redirect to provider-hosted payment page URL.
		// (Docs: CF initialize returns paymentPageUrl.)
		if (wantsRedirect && isSafeIyzicoRedirectUrl(paymentPageUrl)) {
			return sendTopRedirect(res, paymentPageUrl);
		}

		return res.render('shop/checkout', {
			title: 'Ödeme',
			layout: 'layouts/shop',
			cartCount,
			lines,
			total,
			query: req.query,
			checkoutFormContent,
			paymentToken: token || null,
			paymentOrderId: orderId,
			paymentError: null,
		});
	} catch (err) {
		const errorId = Date.now();
		try {
			logger.error(`Checkout error [${errorId}]: ${err && err.message ? err.message : String(err)}`, {
				errorId,
				code: err && err.code ? err.code : null,
				statusCode: err && (err.statusCode || err.status) ? (err.statusCode || err.status) : null,
				stack: err && err.stack ? err.stack : null,
				path: req.originalUrl,
				method: req.method,
				userId: req.session?.userId || null,
				shopUserId: req.shopUser?.id || null,
			});
		} catch {
			// ignore
		}
		return res.redirect(`/checkout?error=1&reason=server&errorId=${encodeURIComponent(String(errorId))}`);
	}
}

async function redirectToHostedPayment(req, res, next) {
	try {
		const wantsJson = isExplicitJsonRequest(req);
		const orderId = String(req.query?.orderId || '').trim();
		if (!orderId) return res.redirect('/checkout');

		const order = await orderModel.getOrderWithItems(orderId);
		if (!order) {
			return res.status(404).render('pages/404', { title: 'Sayfa Bulunamadı', layout: 'layouts/shop' });
		}

		let allowed = false;
		if (req.shopUser && req.shopUser.id) {
			const shopUserId = String(req.shopUser.id);
			if (order.shop_user_id && String(order.shop_user_id) === shopUserId) {
				allowed = true;
			} else {
				const userEmail = String(req.shopUser?.email || '').trim().toLowerCase();
				const orderEmail = String(order.customer_email || '').trim().toLowerCase();
				if (!order.shop_user_id && userEmail && orderEmail && userEmail === orderEmail) {
					allowed = true;
				}
			}
		}
		if (!allowed) {
			return res.status(404).render('pages/404', { title: 'Sayfa Bulunamadı', layout: 'layouts/shop' });
		}

		const payStatus = String(order.payment_status || '').trim().toLowerCase();
		if (payStatus === 'paid') {
			return res.redirect(`/order-success?orderId=${encodeURIComponent(String(orderId))}`);
		}
		if (payStatus === 'refunded' || payStatus === 'partial_refunded') {
			if (order.tracking_code) return res.redirect(`/track?code=${encodeURIComponent(String(order.tracking_code))}`);
			return res.redirect('/orders');
		}

		const shopBaseUrl = getShopBaseUrl(req) || getAppBaseUrl(req);
		const customerName = String(order.customer_full_name || '').trim();
		const buyerName = splitNameTR(customerName);
		const phone = String(order.customer_phone || '').trim();
		const email = String(order.customer_email || '').trim();
		const shippingAddress = String(order.shipping_address || '').trim();
		const totalAmount = Number(order.total_amount) || 0;

		let initialize;
		try {
			const cbBase = String(shopBaseUrl || '').replace(/\/+$/, '');
			const cbUrl = `${cbBase}/payment-callback?orderId=${encodeURIComponent(String(orderId))}`;
			const checkoutPayload = createCheckoutForm({
				cartItems: (order.items || []).map((it, index) => ({
					id: String(it.product_id || it.id || index + 1),
					name: String(it.product_name || 'Ürün'),
					category1: 'Shop',
					unitPrice: Number(it.price_at_purchase) || 0,
					quantity: Number(it.quantity) || 1,
				})),
				buyer: {
					id: String(order.user_id || orderId),
					name: buyerName.name,
					surname: buyerName.surname,
					gsmNumber: String(phone),
					email: String(email || '').trim() || 'no-reply@example.com',
					identityNumber: String(process.env.IYZICO_DEFAULT_IDENTITY_NUMBER || '11111111111'),
					registrationAddress: String(shippingAddress),
					ip: getClientIp(req),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
				},
				shippingAddress: {
					contactName: String(customerName || 'Müşteri'),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
					address: String(shippingAddress),
					zipCode: String(process.env.IYZICO_DEFAULT_ZIP || '00000'),
				},
				billingAddress: {
					contactName: String(customerName || 'Müşteri'),
					city: String(process.env.IYZICO_DEFAULT_CITY || 'Istanbul'),
					country: String(process.env.IYZICO_DEFAULT_COUNTRY || 'Turkey'),
					address: String(shippingAddress),
					zipCode: String(process.env.IYZICO_DEFAULT_ZIP || '00000'),
				},
				conversationId: String(orderId),
				basketId: String(orderId),
				price: totalAmount,
				paidPrice: totalAmount,
				callbackUrl: cbUrl,
				callbackBaseUrl: shopBaseUrl,
			});

			initialize = await checkoutFormInitialize(checkoutPayload);
		} catch {
			return res.status(200).render('shop/hosted-payment', {
				title: 'Ödeme',
				layout: 'layouts/shop',
				orderId,
				checkoutFormContent: null,
				paymentError: 'Ödeme başlatılamadı. Lütfen tekrar deneyin.',
			});
		}

		if (!initialize || String(initialize.status || '').toLowerCase() !== 'success') {
			try {
				const e = extractIyzicoError(initialize);
				await orderModel.setOrderPaymentFailureDetails({
					orderId,
					errorCode: e.errorCode,
					errorMessage: e.errorMessage,
					errorGroup: e.errorGroup,
					raw: e.raw,
				});
			} catch {
				// ignore
			}
			return res.status(200).render('shop/hosted-payment', {
				title: 'Ödeme',
				layout: 'layouts/shop',
				orderId,
				checkoutFormContent: null,
				paymentError: String(initialize?.errorMessage || 'Ödeme başlatılamadı'),
			});
		}

		const token = String(initialize.token || '').trim();
		const checkoutFormContent = ensureResponsiveCheckoutFormContent(initialize.checkoutFormContent || '');
		const paymentPageUrl = pickIyzicoPaymentPageUrl(initialize);
		if (token) {
			try {
				await orderModel.setOrderPaymentInit({ orderId, paymentToken: token });
			} catch {
				// ignore
			}
		}

		// Prefer provider-hosted payment page if available.
		if (isSafeIyzicoRedirectUrl(paymentPageUrl)) {
			if (wantsJson) {
				return res.status(200).json({ ok: true, mode: 'redirect', orderId: String(orderId), token: token || null, paymentPageUrl });
			}
			return sendTopRedirect(res, paymentPageUrl);
		}

		if (wantsJson) {
			return res.status(200).json({ ok: false, error: 'payment_page_url_missing', orderId: String(orderId), token: token || null });
		}

		return res.status(200).render('shop/hosted-payment', {
			title: 'Ödeme',
			layout: 'layouts/shop',
			orderId,
			checkoutFormContent,
			paymentError: null,
		});
	} catch (err) {
		next(err);
	}
}

async function renderPaymentRedirect(req, res, next) {
	try {
		const toRaw = String(req.query?.to || req.query?.redirectUrl || req.query?.url || '').trim();
		const mode = String(req.query?.mode || '').trim().toLowerCase();
		const decodedTo = (() => {
			try {
				return decodeURIComponent(toRaw);
			} catch {
				return toRaw;
			}
		})();
		const target = isSafeInternalRedirect(decodedTo) ? decodedTo : '/';
		return res.status(200).render('shop/payment-redirect', {
			title: 'Yönlendiriliyor',
			layout: 'layouts/shop',
			redirectMode: mode === 'success' ? 'success' : 'pay',
			redirectUrl: target,
			paymentOrderId: String(req.query?.orderId || '').trim() || null,
		});
	} catch (err) {
		next(err);
	}
}


async function paymentCallback(req, res, next) {
	console.log('[iyzico] paymentCallback received', {
		method: req.method,
		path: req.originalUrl,
		ip: getClientIp(req),
		headers: req.headers,
		body: req.body,
	});
	try {
		const orderIdFromQuery = String(req.query?.orderId || '').trim();
		if (orderIdFromQuery) {
			// Fastest path: orderId is provided in callbackUrl, so we don't need to parse POST body.
			// Kick off finalize via stored token (if any) and redirect immediately.
			try {
				const info = await orderModel.getOrderPaymentInfo(orderIdFromQuery);
				const storedToken = String(info?.payment_token || '').trim();
				if (storedToken) {
					Promise.resolve()
						.then(() => finalizeOrder({ token: storedToken }))
						.catch(() => {});
				}
			} catch {
				// ignore
			}
			return sendTopRedirect(
				res,
				buildRedirectUrl({
					to: `/order-success?orderId=${encodeURIComponent(orderIdFromQuery)}`,
					orderId: String(orderIdFromQuery),
					mode: 'success',
				})
			);
		}

		const token = String(req.body?.token || req.query?.token || '').trim();
		if (!token) return sendTopRedirect(res, '/cart?error=1&reason=payment');

		// Fast-path: avoid blocking the callback response on external Iyzipay calls.
		// Lookup orderId from our DB and redirect the user immediately to a page that
		// can poll /order-status while payment finalization runs.
		let orderId = null;
		try {
			orderId = await orderModel.getOrderIdByPaymentToken(token);
		} catch {
			orderId = null;
		}

		// Fire-and-forget finalize (short bounded wait to warm up state).
		try {
			const p = finalizeOrder({ token });
			const timeoutMs = 8_000;
			await Promise.race([
				p,
				new Promise((resolve) => setTimeout(resolve, timeoutMs)),
			]);
		} catch {
			// ignore
		}

		if (orderId) {
			return sendTopRedirect(
				res,
				buildRedirectUrl({
					to: `/order-success?orderId=${encodeURIComponent(String(orderId))}`,
					orderId: String(orderId),
					mode: 'success',
				})
			);
		}

		// If we cannot map token -> order, fallback to cart. Background sync job may still finalize.
		return sendTopRedirect(res, '/cart?error=1&reason=payment&message=processing');
	} catch (err) {
		try {
			logger.error('[shop] paymentCallback failed', {
				message: err?.message,
				code: err?.code,
				stack: err?.stack,
			});
		} catch {
			// ignore
		}
		return sendTopRedirect(res, '/cart?error=1&reason=payment');
	}
}

// GET handler for callback URLs.
// Iyzipay may navigate the browser to callbackUrl (depending on checkout mode),
// and users may also manually open it from history. We never process payments on GET;
// we primarily redirect to a safe, token-protected success page. As a fallback (when
// Iyzipay navigates via GET but the token is only stored on our side), we may attempt
// a best-effort retrieve+finalize before redirecting.
async function paymentCallbackGet(req, res, next) {
	try {
		const orderIdFromQuery = String(req.query?.orderId || '').trim();
		if (orderIdFromQuery) {
			// GET should never do payment work; redirect to safe page.
			return sendTopRedirect(
				res,
				buildRedirectUrl({
					to: `/order-success?orderId=${encodeURIComponent(orderIdFromQuery)}`,
					orderId: String(orderIdFromQuery),
					mode: 'success',
				})
			);
		}
		const token = String(req.query?.token || req.query?.pt || '').trim();
		if (token) {
			let orderId = null;
			try {
				orderId = await orderModel.getOrderIdByPaymentToken(token);
			} catch {
				orderId = null;
			}

			try {
				const p = finalizeOrder({ token });
				const timeoutMs = 8_000;
				await Promise.race([
					p,
					new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				]);
			} catch {
				// ignore
			}

			if (orderId) {
				return sendTopRedirect(
					res,
					buildRedirectUrl({
						to: `/order-success?orderId=${encodeURIComponent(String(orderId))}`,
						orderId: String(orderId),
						mode: 'success',
					})
				);
			}
			return sendTopRedirect(res, '/cart?error=1&reason=payment&message=processing');
		}
		return sendTopRedirect(res, '/cart');
	} catch (err) {
		try {
			logger.error('[shop] paymentCallback GET failed', {
				message: err?.message,
				code: err?.code,
				stack: err?.stack,
			});
		} catch {
			// ignore
		}
		return sendTopRedirect(res, '/cart?error=1&reason=payment');
	}
}

async function getOrderPaymentStatus(req, res, next) {
	try {
		const orderId = String(req.query?.orderId || '').trim();
		if (!orderId) return res.status(400).json({ ok: false, error: 'missing_order_id' });

		const order = await orderModel.getOrderWithItems(orderId);
		if (!order) return res.status(404).json({ ok: false, error: 'order_not_found' });

		let allowed = false;
		if (req.shopUser && req.shopUser.id) {
			const shopUserId = String(req.shopUser.id);
			if (order.shop_user_id && String(order.shop_user_id) === shopUserId) {
				allowed = true;
			} else {
				// Legacy (safer): if order is not linked to a shop user, allow only by matching email.
				const userEmail = String(req.shopUser?.email || '').trim().toLowerCase();
				const orderEmail = String(order.customer_email || '').trim().toLowerCase();
				if (!order.shop_user_id && userEmail && orderEmail && userEmail === orderEmail) {
					allowed = true;
				}
			}
		}

		if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });

		let status = String(order.payment_status || '').trim().toLowerCase();

		// Best-effort self-heal: if payment is still pending but we have a token,
		// try to retrieve and finalize it. This helps when 3DS callback/redirect
		// does not reach the merchant page in production.
		if (status !== 'paid') {
			const token = String(order.payment_token || '').trim();
			if (token) {
				try {
					await finalizeOrder({ token });
					const refreshed = await orderModel.getOrderWithItems(orderId);
					if (refreshed) status = String(refreshed.payment_status || '').trim().toLowerCase();
				} catch {
					// ignore (polling should remain fast and non-fatal)
				}
			}
		}
		const successUrl = `/order-success?orderId=${encodeURIComponent(orderId)}`;
		return res.json({
			ok: true,
			status,
			trackingCode: order.tracking_code || null,
			successUrl,
		});
	} catch (err) {
		next(err);
	}
}

async function renderOrderSuccess(req, res, next) {
	try {
		const orderIdFromQuery = String(req.query?.orderId || '').trim();
		const payload = req.session && req.session.lastOrderSuccess ? req.session.lastOrderSuccess : null;
		const orderId = orderIdFromQuery || (payload && payload.orderId ? String(payload.orderId).trim() : '');
		if (!orderId) return res.redirect('/orders');

		const order = await orderModel.getOrderWithItems(orderId);
		if (!order) {
			return res.status(404).render('pages/404', { title: 'Sayfa Bulunamadı', layout: 'layouts/shop' });
		}

		let payStatus = String(order.payment_status || '').trim().toLowerCase();
		if (payStatus !== 'paid') {
			// Best-effort: if we already have a token stored, attempt a retrieve+finalize
			// so users who manually reach /order-success can still see the completed order.
			const token = String(order.payment_token || '').trim();
			if (token) {
				try {
					await finalizeOrder({ token });
					const refreshed = await orderModel.getOrderWithItems(orderId);
					if (refreshed) {
						payStatus = String(refreshed.payment_status || '').trim().toLowerCase();
						// Keep order reference updated for later rendering.
						order.payment_status = refreshed.payment_status;
						order.payment_id = refreshed.payment_id;
						order.tracking_code = refreshed.tracking_code;
						order.total_amount = refreshed.total_amount;
						order.items = refreshed.items;
					}
				} catch {
					// ignore
				}
			}
		}

		// /order-success is a checkout completion page. For refunded orders, showing
		// "Ödeme işleniyor" is misleading; take the user to tracking instead.
		if (payStatus === 'refunded' || payStatus === 'partial_refunded') {
			if (order.tracking_code) {
				return res.redirect(`/track?code=${encodeURIComponent(String(order.tracking_code))}`);
			}
			return res.redirect('/orders');
		}

		if (payStatus === 'failed') {
			return res.redirect('/orders?pay_err=failed');
		}

		if (payStatus !== 'paid') {
			return res.status(200).render('shop/order-processing', {
				title: 'Ödeme İşleniyor',
				layout: 'layouts/shop',
				orderId,
				trackingCode: order?.tracking_code || null,
			});
		}

		let allowed = true;
		if (req.shopUser && req.shopUser.id) {
			allowed = false;
			const shopUserId = String(req.shopUser.id);
			if (order.shop_user_id && String(order.shop_user_id) === shopUserId) {
				allowed = true;
			} else {
				const userEmail = String(req.shopUser?.email || '').trim().toLowerCase();
				const orderEmail = String(order.customer_email || '').trim().toLowerCase();
				if (!order.shop_user_id && userEmail && orderEmail && userEmail === orderEmail) {
					allowed = true;
				}
			}
		}
		if (!allowed) {
			return res.status(404).render('pages/404', { title: 'Sayfa Bulunamadı', layout: 'layouts/shop' });
		}

		// Best-effort: remove purchased items from the cart so they disappear after payment.
		try {
			const purchasedProductIds = Array.from(
				new Set((order.items || []).map((it) => String(it.product_id || '').trim()).filter(Boolean))
			);
			if (purchasedProductIds.length > 0) {
				const shopUserId = order.shop_user_id
					? String(order.shop_user_id)
					: (req.shopUser && req.shopUser.id ? String(req.shopUser.id) : null);
				if (shopUserId) {
					await cartModel.removeItemsFromCart({ userId: shopUserId, productIds: purchasedProductIds });
				}
				if (req.session && req.session.cart && Array.isArray(req.session.cart.items)) {
					req.session.cart.items = (req.session.cart.items || []).filter((x) => !purchasedProductIds.includes(String(x.productId || '').trim()));
				}
			}
		} catch {
			// ignore
		}

		// One-time display: clear session flag when present.
		if (req.session && req.session.lastOrderSuccess) {
			try {
				delete req.session.lastOrderSuccess;
				await new Promise((resolve) => req.session.save(resolve));
			} catch {
				// ignore
			}
		}

		return res.render('shop/order-success', {
			title: 'Sipariş Onayı',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
			orderId: order.id,
			trackingCode: order.tracking_code || (payload && payload.trackingCode) || null,
			totalAmount: order.total_amount != null ? order.total_amount : (payload && payload.totalAmount) || null,
			paymentId: order.payment_id || (payload && payload.paymentId) || null,
			items: Array.isArray(order.items) ? order.items : [],
		});
	} catch (err) {
		next(err);
	}
}

function statusLabelTR(status) {
	try {
		const { orderStageLabelTR } = require('../utils/statusLabels');
		return orderStageLabelTR(status);
	} catch {
		return status === 'pending'
			? 'Sipariş Alındı'
			: status === 'shipped'
				? 'Kargoya Verildi'
				: status === 'completed'
					? 'Teslim Edildi'
					: status === 'cancelled'
						? 'İptal Edildi'
						: String(status || '');
	}
}

async function renderOrderTracking(req, res, next) {
	try {
		const code = String(req.query.code || '').trim();
		if (!code) {
			return res.render('shop/track', {
				title: 'Sipariş Takibi',
				layout: 'layouts/shop',
				cartCount: await getCartCount(req),
				code: '',
				order: null,
				cancellationRequest: null,
				rtOrderId: '',
				rtTrackingCode: '',
				error: null,
				statusLabelTR,
				orderStatusLabelTR,
				paymentStatusLabelTR,
			});
		}
		const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code);
		const order = isUuid
			? await orderModel.getOrderDetail(code)
			: await orderModel.getOrderDetailByTrackingCode(code);
		if (!order) {
			return res.status(404).render('shop/track', {
				title: 'Sipariş Takibi',
				layout: 'layouts/shop',
				cartCount: await getCartCount(req),
				code,
				order: null,
				cancellationRequest: null,
				rtOrderId: '',
				rtTrackingCode: '',
				error: 'Bu bilgi ile bir sipariş bulunamadı. Takip kodunu veya sipariş numaranı kontrol et.',
				statusLabelTR,
				orderStatusLabelTR,
				paymentStatusLabelTR,
			});
		}

		// Only show orders after payment is completed.
		const payStatus = String(order.payment_status || '').trim().toLowerCase();
		const orderStatus = String(order.status || '').trim().toLowerCase();
		const allowedPaymentStatuses = new Set(['paid', 'partial_refunded', 'refunded']);
		const cancelledAllowed = payStatus === 'refunded' || payStatus === 'partial_refunded';
		if (!allowedPaymentStatuses.has(payStatus) || (orderStatus === 'cancelled' && !cancelledAllowed)) {
			return res.status(404).render('shop/track', {
				title: 'Sipariş Takibi',
				layout: 'layouts/shop',
				cartCount: await getCartCount(req),
				code,
				order: null,
				cancellationRequest: null,
				rtOrderId: '',
				rtTrackingCode: '',
				error: 'Bu bilgi ile bir sipariş bulunamadı. Takip kodunu veya sipariş numaranı kontrol et.',
				statusLabelTR,
				orderStatusLabelTR,
				paymentStatusLabelTR,
			});
		}

		const cancellationRequest = await cancellationRequestModel.getActiveCancellationRequestForOrder(order.id);
		const latestCancellationRequest = typeof cancellationRequestModel.getLatestCancellationRequestForOrder === 'function'
			? await cancellationRequestModel.getLatestCancellationRequestForOrder(order.id)
			: null;

		return res.render('shop/track', {
			title: 'Sipariş Takibi',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
			code,
			order,
			cancellationRequest: latestCancellationRequest || cancellationRequest,
			rtOrderId: String(order.id || ''),
			rtTrackingCode: String(order.tracking_code || ''),
			error: null,
			statusLabelTR,
			orderStatusLabelTR,
			paymentStatusLabelTR,
		});
	} catch (err) {
		next(err);
	}
}

async function renderMyOrders(req, res, next) {
	try {
		const cartCount = await getCartCount(req);
		const u = req.shopUser;
		const shopUserId = u && u.id ? String(u.id) : '';
		const shopUserEmail = String(u && u.email ? u.email : '').trim().toLowerCase() || null;
		let orders = shopUserId
			? await orderModel.listOrdersByShopUserId(shopUserId, { limit: 200, email: shopUserEmail })
			: [];

		// Best-effort: try to sync a few recent pending orders so they appear as paid
		// even when 3DS redirect/callback did not complete.
		try {
			const candidates = (orders || [])
				.filter((o) => String(o.payment_status || '').trim().toLowerCase() !== 'paid')
				.slice(0, 3);
			for (const o of candidates) {
				try {
					const info = await orderModel.getOrderPaymentInfo(o.id);
					const token = String(info?.payment_token || '').trim();
					if (token) await finalizeOrder({ token });
				} catch {
					// ignore
				}
			}
			orders = shopUserId
				? await orderModel.listOrdersByShopUserId(shopUserId, { limit: 200, email: shopUserEmail })
				: [];
		} catch {
			// ignore
		}
		const reqRows = await cancellationRequestModel.listActiveCancellationRequestsForOrders((orders || []).map((o) => o.id));
		const cancelRequestsByOrderId = new Map();
		for (const r of reqRows || []) cancelRequestsByOrderId.set(r.order_id, r);

		// UI rule: hide orders whose payment is still pending/failed.
		const ordersForDisplay = (orders || []).filter((o) => {
			const ps = String(o?.payment_status || '').trim().toLowerCase();
			return ps && ps !== 'pending' && ps !== 'failed';
		});
		return res.render('shop/orders', {
			title: 'Siparişlerim',
			layout: 'layouts/shop',
			cartCount,
			orders: ordersForDisplay,
			query: req.query,
			statusLabelTR,
			orderStatusLabelTR,
			paymentStatusLabelTR,
			cancelRequestsByOrderId,
		});
	} catch (err) {
		next(err);
	}
}

async function cancelOrder(req, res, next) {
	try {
		const u = req.shopUser;
		const orderId = String(req.params.id || '').trim();
		const shopUserId = u && u.id ? String(u.id) : null;
		const shopUserEmail = String(u && u.email ? u.email : '').trim().toLowerCase() || null;
		if (!shopUserId) return res.redirect('/orders?cancel_err=invalid');

		const order = await orderModel.getOrderWithItems(orderId);
		if (!order) return res.redirect('/orders?cancel_err=notfound');
		// Ownership: strict shop_user_id, with safe legacy fallback by email only.
		const ownsByShopUser = shopUserId && order.shop_user_id && String(order.shop_user_id) === String(shopUserId);
		const ownsByEmail = !order.shop_user_id && shopUserEmail && String(order.customer_email || '').trim().toLowerCase() === shopUserEmail;
		if (!ownsByShopUser && !ownsByEmail) return res.redirect('/orders?cancel_err=forbidden');

		const orderStatus = String(order.status || '').trim().toLowerCase();
		if (orderStatus !== 'pending') return res.redirect('/orders?cancel_err=status');
		const paymentStatus = String(order.payment_status || '').trim().toLowerCase();

		// If payment was captured, we create a cancellation/refund request instead of hard cancelling.
		if (paymentStatus === 'paid' || paymentStatus === 'partial_refunded') {
			let created = null;
			try {
				created = await cancellationRequestModel.createCancellationRequest({
					orderId,
					shopUserId,
					customerNote: null,
				});
			} catch (e) {
				if (e?.statusCode === 403) return res.redirect('/orders?cancel_err=forbidden');
				if (e?.statusCode === 404) return res.redirect('/orders?cancel_err=notfound');
				if (e?.code === 'ORDER_STATUS') return res.redirect('/orders?cancel_err=status');
				if (e?.code === 'PAYMENT_STATUS') return res.redirect('/orders?cancel_err=invalid');
				return res.redirect('/orders?cancel_err=invalid');
			}

			// Fire-and-forget emails: request received
			try {
				const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
				const deriveShopAdminBaseUrl = () => {
					const base = getAppBaseUrl(req);
					try {
						const url = new URL(base);
						const host = String(url.hostname || '').toLowerCase();
						const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
						const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
						if (shopPrefix && shopAdminPrefix && host.startsWith(shopPrefix)) {
							url.hostname = shopAdminPrefix + host.slice(shopPrefix.length);
						}
						return url.origin;
					} catch {
						return '';
					}
				};
				void (async () => {
					const customerEmail = String(order.customer_email || '').trim();
					const customerName = String(order.customer_full_name || '').trim();
					const customerPhone = String(order.customer_phone || '').trim();
					const trackingCode = String(order.tracking_code || '').trim();
					const items = Array.isArray(order.items) ? order.items : [];
					const totalAmount = Number(order.total_amount) || 0;
					const shippingAddress = String(order.shipping_address || '').trim();

					if (customerEmail) {
						const html = await getTemplate('shop/order-cancellation-requested-customer', {
							appBaseUrl: getAppBaseUrl(req),
							orderId: order.id,
							trackingCode,
							customerName,
							items,
							totalAmount,
							shippingAddress,
							paymentStatusLabel: paymentStatusLabelTR(order.payment_status),
						});
						await sendEmail(customerEmail, 'İade Talebiniz Alındı', html, { channel: 'shop' });
					}

					if (adminEmail) {
						const html = await getTemplate('shop/order-cancellation-requested-admin', {
							appBaseUrl: deriveShopAdminBaseUrl(),
							orderId: order.id,
							trackingCode,
							customerName,
							customerEmail,
							customerPhone,
							items,
							totalAmount,
							shippingAddress,
							requestId: created?.requestId || null,
						});
						await sendEmail(adminEmail, 'İade Talebi (Müşteri)', html, { channel: 'shop' });
					}
				})().catch((err) => {
					logger.error('[shop] cancellation request emails failed', {
						message: err?.message,
						code: err?.code,
						orderId,
						stack: err?.stack,
					});
				});
			} catch {
				// ignore
			}

			return res.redirect(`/orders?cancel_req_${created && created.alreadyExists ? 'exists' : 'ok'}=1`);
		}

		const result = await orderModel.cancelOrderByShopUser({ orderId, shopUserId, email: shopUserEmail });

		// Fire-and-forget: cancellation emails
		try {
			const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
			const deriveShopAdminBaseUrl = () => {
				const base = getAppBaseUrl(req);
				try {
					const url = new URL(base);
					const host = String(url.hostname || '').toLowerCase();
					const shopPrefix = String(process.env.SHOP_HOSTNAME_PREFIX || 'shop.').trim().toLowerCase();
					const shopAdminPrefix = String(process.env.SHOP_ADMIN_HOSTNAME_PREFIX || 'shopadmin.').trim().toLowerCase();
					if (shopPrefix && shopAdminPrefix && host.startsWith(shopPrefix)) {
						url.hostname = shopAdminPrefix + host.slice(shopPrefix.length);
					}
					return url.origin;
				} catch {
					return '';
				}

				// Real-time notify (best-effort)
				try {
					void (async () => {
						const io = socketService.getIO();
						const trackingCode = String(order.tracking_code || '').trim();
						const payload = {
							orderId: String(orderId),
							status: 'requested',
							trackingCode: trackingCode || null,
							requestId: created?.requestId || null,
							createdAt: new Date().toISOString(),
						};
						io.to('adminRoom').emit('cancellationRequestUpdated', payload);
						io.to(`order:${String(orderId)}`).emit('cancellationRequestUpdated', payload);
						if (trackingCode) io.to(`tracking:${trackingCode}`).emit('cancellationRequestUpdated', payload);
						if (shopUserId) io.to(`customer:${String(shopUserId)}`).emit('cancellationRequestUpdated', payload);
					})().catch(() => {});
				} catch {
					// ignore
				}
			};
			void (async () => {
				const order = await orderModel.getOrderWithItems(result.orderId);
				if (!order) return;

				const customerEmail = String(order.customer_email || '').trim();
				const customerName = String(order.customer_full_name || '').trim();
				const customerPhone = String(order.customer_phone || '').trim();
				const trackingCode = String(order.tracking_code || '').trim();
				const items = Array.isArray(order.items) ? order.items : [];
				const totalAmount = Number(order.total_amount) || 0;
				const shippingAddress = String(order.shipping_address || '').trim();

				if (customerEmail) {
					const html = await getTemplate('shop/order-cancelled-customer', {
						appBaseUrl: getAppBaseUrl(req),
						orderId: order.id,
						trackingCode,
						customerName,
						items,
						totalAmount,
						shippingAddress,
					});
					await sendEmail(customerEmail, 'Siparişiniz İptal Edildi', html, { channel: 'shop' });
				}

				if (adminEmail) {
					const html = await getTemplate('shop/order-cancelled-admin', {
						appBaseUrl: deriveShopAdminBaseUrl(),
						orderId: order.id,
						trackingCode,
						customerName,
						customerEmail,
						customerPhone,
						items,
						totalAmount,
						shippingAddress,
					});
					await sendEmail(adminEmail, 'Kullanıcı Siparişi İptal Etti', html, { channel: 'shop' });
				}
			})().catch((err) => {
				logger.error('[shop] order cancellation emails failed', {
					message: err?.message,
					code: err?.code,
					orderId: result.orderId,
					stack: err?.stack,
				});
			});
		} catch (err) {
			logger.error('[shop] failed to schedule cancellation emails', {
				message: err?.message,
				code: err?.code,
				stack: err?.stack,
			});
		}

		return res.redirect('/orders?cancel_ok=1');
	} catch (err) {
		if (err?.code === 'PAID_ORDER') return res.redirect('/orders?cancel_err=paid');
		const status = err?.statusCode;
		if (status === 403) return res.redirect('/orders?cancel_err=forbidden');
		if (status === 404) return res.redirect('/orders?cancel_err=notfound');
		if (status === 409) return res.redirect('/orders?cancel_err=status');
		if (status === 400) return res.redirect('/orders?cancel_err=invalid');
		return next(err);
	}
}

async function renderMyAccount(req, res, next) {
	try {
		const cartCount = await getCartCount(req);
		const u = req.shopUser;
		const shopUserId = u && u.id ? String(u.id) : '';
		const shopUserEmail = String(u && u.email ? u.email : '').trim().toLowerCase() || null;
		const orders = shopUserId
			? await orderModel.listOrdersByShopUserId(shopUserId, { limit: 200, email: shopUserEmail })
			: [];

		// UI rule: hide orders whose payment is still pending/failed.
		const ordersForUi = (orders || []).filter((o) => {
			const ps = String(o?.payment_status || '').trim().toLowerCase();
			return ps && ps !== 'pending' && ps !== 'failed';
		});

		const paidLike = new Set(['paid', 'partial_refunded', 'refunded']);
		const effectiveOrders = Array.isArray(ordersForUi) ? ordersForUi : [];
		const totalRefunded = effectiveOrders.reduce((sum, o) => sum + (Number(o.refunded_amount) || 0), 0);
		const totalCharged = effectiveOrders
			.filter((o) => paidLike.has(String(o.payment_status || '').trim().toLowerCase()))
			.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
		const activeCount = effectiveOrders.filter((o) => {
			const st = String(o.status || '').trim().toLowerCase();
			const ps = String(o.payment_status || '').trim().toLowerCase();
			// Active lifecycle: paid/partial refunded orders that are still progressing.
			return (ps === 'paid' || ps === 'partial_refunded') && (st === 'pending' || st === 'shipped');
		}).length;

		const orderSummary = {
			totalOrders: effectiveOrders.length,
			totalCharged,
			totalRefunded,
			activeCount,
			lastOrderAt: effectiveOrders[0] && effectiveOrders[0].created_at ? effectiveOrders[0].created_at : null,
			lastOrderStatus: effectiveOrders[0] && effectiveOrders[0].status ? effectiveOrders[0].status : null,
			lastOrderPaymentStatus: effectiveOrders[0] && effectiveOrders[0].payment_status ? effectiveOrders[0].payment_status : null,
		};

		return res.render('shop/account', {
			title: 'Hesabım',
			layout: 'layouts/shop',
			cartCount,
			user: u || null,
			orders: effectiveOrders.slice(0, 5),
			orderSummary,
			statusLabelTR,
			orderStatusLabelTR,
			paymentStatusLabelTR,
		});
	} catch (err) {
		next(err);
	}
}

async function renderPrivacyPolicy(req, res, next) {
	try {
		res.render('shop/privacy', {
			title: 'Gizlilik',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderCookiePolicy(req, res, next) {
	try {
		res.render('shop/cookies', {
			title: 'Çerez Politikası',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderShippingReturns(req, res, next) {
	try {
		res.render('shop/shipping-returns', {
			title: 'Teslimat ve İade',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderShopAbout(req, res, next) {
	try {
		res.render('shop/about', {
			title: 'Hakkımızda',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderShopContact(req, res, next) {
	try {
		const q = (typeof req.query === 'object' && req.query) ? req.query : {};
		const ok = String(q.ok || '') === '1';
		const err = String(q.err || '') === '1';
		res.render('shop/contact', {
			title: 'İletişim',
			layout: 'layouts/shop',
			success: ok ? 'Mesajınız alındı. En kısa sürede size dönüş yapacağız.' : null,
			error: err ? 'Mesajınız gönderilemedi. Lütfen tekrar deneyin.' : null,
			form: {
				fullName: (req.shopUser && req.shopUser.full_name) ? String(req.shopUser.full_name) : '',
				email: (req.shopUser && req.shopUser.email) ? String(req.shopUser.email) : '',
				phone: (req.shopUser && req.shopUser.phone) ? String(req.shopUser.phone) : '',
				subject: '',
				message: '',
			},
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function submitShopContact(req, res, next) {
	try {
		const fullName = String(req.body.fullName || '').trim();
		const email = String(req.body.email || '').trim().toLowerCase();
		const phone = String(req.body.phone || '').trim();
		const subject = String(req.body.subject || '').trim();
		const message = String(req.body.message || '').trim();

		const createdIp = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
		const userAgent = String(req.headers['user-agent'] || '').trim();

		const created = await shopContactModel.createMessage({
			shopUserId: req.shopUser && req.shopUser.id ? req.shopUser.id : null,
			fullName: fullName || (req.shopUser && req.shopUser.full_name ? req.shopUser.full_name : null),
			email,
			phone: phone || (req.shopUser && req.shopUser.phone ? req.shopUser.phone : null),
			subject: subject || null,
			message,
			createdIp: createdIp || null,
			userAgent: userAgent || null,
		});

		// Optional: notify ShopAdmin via email (best-effort)
		try {
			const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
			const notifyEnabled = String(process.env.SHOP_CONTACT_NOTIFY_EMAIL || '1') === '1';
			if (notifyEnabled && adminEmail) {
				const appBaseUrl = getAppBaseUrl(req);
				const html = await getTemplate('shop/contact-message-admin', {
					fullName: fullName || (req.shopUser && req.shopUser.full_name) || null,
					email,
					phone: phone || (req.shopUser && req.shopUser.phone) || null,
					subject: subject || null,
					message,
					messageId: created ? created.id : null,
					appBaseUrl,
				});
				await sendEmail(adminEmail, 'Yeni İletişim Mesajı', html, { channel: 'shop' });
			}
		} catch (err) {
			logger.warn('[shop] contact notify email failed (continuing)', { message: err?.message });
		}

		return res.redirect('/iletisim?ok=1');
	} catch (err) {
		logger.error('[shop] submitShopContact failed', { message: err?.message, stack: err?.stack });
		return res.redirect('/iletisim?err=1');
	}
}

async function renderDistanceSales(req, res, next) {
	try {
		res.render('shop/legal/distance-sales', {
			title: 'Mesafeli Satış Sözleşmesi',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderLegalPrivacyPolicy(req, res, next) {
	try {
		res.render('shop/legal/privacy-policy', {
			title: 'Gizlilik ve Güvenlik Politikası',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

async function renderCancellationRefund(req, res, next) {
	try {
		res.render('shop/legal/cancellation-refund', {
			title: 'İptal ve İade Koşulları',
			layout: 'layouts/shop',
			cartCount: await getCartCount(req),
		});
	} catch (err) {
		next(err);
	}
}

module.exports = {
	renderShopHome,
	renderShopProducts,
	renderProduct,
	renderCart,
	addToCart,
	removeFromCart,
	updateCartItem,
	renderCheckout,
	placeOrder,
	redirectToHostedPayment,
	renderPaymentRedirect,
	renderOrderSuccess,
	getOrderPaymentStatus,
	paymentCallbackGet,
	paymentCallback,
	renderOrderTracking,
	renderMyAccount,
	renderMyOrders,
	cancelOrder,
	renderPrivacyPolicy,
	renderCookiePolicy,
	renderShippingReturns,
	renderDistanceSales,
	renderLegalPrivacyPolicy,
	renderCancellationRefund,
	renderShopAbout,
	renderShopContact,
	submitShopContact,
};
