const adminModel = require('../models/adminModel');
const shopModel = require('../models/shopModel');
const orderModel = require('../models/orderModel');
const cancellationRequestModel = require('../models/cancellationRequestModel');
const shopContactModel = require('../models/shopContactModel');
const { businessLogger, logger } = require('../config/logger');
const { getTemplate, sendEmail } = require('../services/emailService');
const { getContactNotifyToEmail, getShopNotifyToEmail } = require('../config/email');
const analyticsModel = require('../models/analyticsModel');
const { iyzico } = require('../config/iyzico');
const { paymentRetrieve, checkoutFormRetrieve } = require('../services/iyzicoPaymentService');
const path = require('path');
const { Readable } = require('stream');
const csvParser = require('csv-parser');
const ExcelJS = require('exceljs');
const request = require('postman-request');
const iyzipayUtils = require('iyzipay/lib/utils');
const { getAppBaseUrl, getShopBaseUrl } = require('../utils/appBaseUrl');
const { paymentStatusLabelTR } = require('../utils/statusLabels');
const { runOncePaymentSync } = require('../jobs/paymentSync');

/** Iyzico'nun "iade edilemez" tarzı hata metinlerini tespit eder (son kullanıcı mesajı için). */
function isIyzicoNotRefundableMessage(msg) {
	if (!msg || typeof msg !== 'string') return false;
	const s = msg.trim().toLowerCase();
	return s.includes('cannot be cancelled') || s.includes('refund or post auth') || (s.includes('success') && s.includes('cannot'));
}

function extractPaymentItemsFromIyzicoResponse(result) {
	const src = result || {};
	const raw =
		(Array.isArray(src.paymentItems) ? src.paymentItems : null)
		|| (Array.isArray(src.itemTransactions) ? src.itemTransactions : null)
		|| (Array.isArray(src.itemTransactionList) ? src.itemTransactionList : null)
		|| (Array.isArray(src.itemTransaction) ? src.itemTransaction : null)
		|| [];

	const out = [];
	for (const it of raw) {
		const paymentTransactionId = String(it?.paymentTransactionId || it?.paymentTransaction?.paymentTransactionId || '').trim();
		if (!paymentTransactionId) continue;
		const paidPrice = toNumber(it?.paidPrice);
		const price = toNumber(it?.price);
		out.push({
			paymentTransactionId,
			paidPrice: Number.isFinite(paidPrice) ? paidPrice : null,
			price: Number.isFinite(price) ? price : null,
			currency: String(src.currency || it?.currency || 'TRY').trim() || 'TRY',
		});
	}
	return out;
}

async function ensureOrderHasPaymentItems({ orderId, paymentId, paymentToken }) {
	if (!orderId || (!paymentId && !paymentToken)) return [];

	let lastFailure = null;

	// 1) Preferred: retrieve by paymentId
	if (paymentId) {
		try {
			const conversationId = `${orderId}:payment_items:payment:${Date.now()}`;
			const result = await paymentRetrieve({
				locale: 'tr',
				conversationId,
				paymentId: String(paymentId),
			});
			const ok = String(result?.status || '').trim().toLowerCase() === 'success';
			if (ok) {
				const items = extractPaymentItemsFromIyzicoResponse(result);
				if (items.length > 0) {
					await orderModel.setOrderPaymentItems({ orderId, paymentItems: items });
					return items;
				}
				lastFailure = { stage: 'payment.retrieve', reason: 'no_items', resultStatus: result?.status, errorMessage: result?.errorMessage };
			} else {
				lastFailure = { stage: 'payment.retrieve', reason: 'not_success', resultStatus: result?.status, errorMessage: result?.errorMessage };
			}
		} catch (err) {
			lastFailure = { stage: 'payment.retrieve', reason: 'exception', code: err?.code, message: err?.message };
		}
	}

	// 2) Fallback: retrieve by checkoutForm token (older/checkout-form-only scenarios)
	if (paymentToken) {
		try {
			const token = String(paymentToken || '').trim();
			if (token) {
				const result = await checkoutFormRetrieve({ locale: 'tr', token });
				const ok = String(result?.status || '').trim().toLowerCase() === 'success';
				if (ok) {
					const items = extractPaymentItemsFromIyzicoResponse(result);
					if (items.length > 0) {
						await orderModel.setOrderPaymentItems({ orderId, paymentItems: items });
						return items;
					}
					lastFailure = { stage: 'checkoutForm.retrieve', reason: 'no_items', resultStatus: result?.status, errorMessage: result?.errorMessage };
				} else {
					lastFailure = { stage: 'checkoutForm.retrieve', reason: 'not_success', resultStatus: result?.status, errorMessage: result?.errorMessage };
				}
			}
		} catch (err) {
			lastFailure = { stage: 'checkoutForm.retrieve', reason: 'exception', code: err?.code, message: err?.message };
		}
	}

	if (lastFailure) {
		logger.warn('[shopAdmin] could not backfill payment_items', { orderId, hasPaymentId: !!paymentId, hasPaymentToken: !!paymentToken, lastFailure });
	}
	return [];
}

function deriveShopBaseUrlFromReq(req) {
	return getShopBaseUrl(req) || getAppBaseUrl(req);
}

function toInt(value) {
	const raw = value === undefined || value === null ? '' : String(value).trim();
	if (raw === '') return NaN;
	const n = Number(raw);
	if (!Number.isFinite(n)) return NaN;
	return Math.trunc(n);
}

function toNumber(value) {
	const raw = value === undefined || value === null ? '' : String(value).trim();
	if (raw === '') return NaN;
	const n = Number(raw.replace(',', '.'));
	if (!Number.isFinite(n)) return NaN;
	return n;
}

function parseOptionList(raw) {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string') return '__invalid__';
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const parts = trimmed
		.split(/[\n,;]+/)
		.map((x) => x.trim())
		.filter(Boolean);
	const unique = Array.from(new Set(parts));
	return unique.length ? unique : null;
}

function parseBoolean(cell) {
	if (cell === undefined || cell === null) return false;
	const s = String(cell).trim().toLowerCase();
	return s === 'true' || s === '1' || s === 'evet' || s === 'yes' || s === 'on';
}

function buildVariantKey({ selectedSize = '', selectedColor = '' } = {}) {
	return JSON.stringify([
		selectedSize == null ? '' : String(selectedSize),
		selectedColor == null ? '' : String(selectedColor),
	]);
}

function normalizeHeaderKey(key) {
	return String(key || '').trim().toLowerCase();
}

function normalizeRowKeys(row) {
	const out = {};
	for (const [k, v] of Object.entries(row || {})) {
		out[normalizeHeaderKey(k)] = v;
	}
	return out;
}

function isUuid(value) {
	const s = String(value || '').trim();
	if (!s) return false;
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function toIyzicoPrice(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return n.toFixed(2);
}

function getClientIp(req) {
	const xf = req && req.headers ? req.headers['x-forwarded-for'] : null;
	const first = Array.isArray(xf) ? xf[0] : xf;
	const fromHeader = first ? String(first).split(',')[0].trim() : '';
	return fromHeader || (req && req.ip ? String(req.ip) : '') || '127.0.0.1';
}

function iyzicoRefundCreate(request) {
	return new Promise((resolve, reject) => {
		try {
			iyzico.refund.create(request, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

function iyzicoCancelCreate(requestBody) {
	return new Promise((resolve, reject) => {
		try {
			if (!iyzico || !iyzico.cancel || typeof iyzico.cancel.create !== 'function') {
				const err = new Error('iyzico.cancel.create is not available');
				err.code = 'IYZICO_CANCEL_UNAVAILABLE';
				return reject(err);
			}
			iyzico.cancel.create(requestBody, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

function iyzicoRefundV2Create({ locale = 'tr', conversationId, paymentId, price, ip, currency = 'TRY' }) {
	return new Promise((resolve, reject) => {
		try {
			const cfg = iyzico && iyzico._config ? iyzico._config : null;
			if (!cfg || !cfg.uri || !cfg.apiKey || !cfg.secretKey) {
				const err = new Error('iyzico config is missing');
				err.code = 'IYZICO_CONFIG_MISSING';
				return reject(err);
			}

			const path = '/v2/payment/refund';
			const body = {
				locale,
				conversationId,
				price,
				paymentId: String(paymentId),
				currency,
				ip,
			};

			const randomString = iyzipayUtils.generateRandomString(8);
			const authorization = iyzipayUtils.generateAuthorizationHeaderV2(
				'IYZWSv2',
				cfg.apiKey,
				':',
				cfg.secretKey,
				path,
				body,
				randomString
			);

			request(
				{
					method: 'POST',
					url: String(cfg.uri).replace(/\/+$/, '') + path,
					headers: {
						'x-iyzi-rnd': randomString,
						Authorization: authorization,
						'Content-Type': 'application/json',
					},
					json: body,
				},
				(err, _res, responseBody) => {
					if (err) return reject(err);
					return resolve(responseBody);
				}
			);
		} catch (e) {
			reject(e);
		}
	});
}

async function performCancelAndRefund({ req, orderId, adminId, sendEmails = true }) {
	let beginOk = false;
	let refundAttempts = [];
	try {
		const redirectFail = (code) => {
			const e = new Error(code || 'refund_error');
			e.code = code;
			e.redirectTo = `/orders/${encodeURIComponent(orderId)}?refund_err=${encodeURIComponent(code)}`;
			throw e;
		};

		const order = await orderModel.beginOrderRefund(orderId);
		beginOk = true;

		const orderStatus = String(order.status || '').trim().toLowerCase();
		if (orderStatus !== 'pending') {
			redirectFail(orderStatus === 'cancelled' ? 'cancelled' : 'order_status');
		}

		const payStatus = String(order.payment_status || '').trim().toLowerCase();
		if (payStatus !== 'paid' && payStatus !== 'partial_refunded' && payStatus !== 'refunded') {
			redirectFail('status');
		}

		const total = Number(order.total_amount) || 0;
		const alreadyRefunded = Number(order.refunded_amount) || 0;
		const remaining = Math.max(0, total - alreadyRefunded);

		let refundFinished = { successDelta: 0 };
		if (remaining > 0.01) {
			if (!order.payment_id) redirectFail('missing_payment_id');
			let paymentItems = Array.isArray(order.payment_items) ? order.payment_items : [];
			if (paymentItems.length === 0) {
				const fetched = await ensureOrderHasPaymentItems({ orderId, paymentId: order.payment_id, paymentToken: order.payment_token });
				paymentItems = fetched.length > 0 ? fetched : [];
			}

			// Fallback path when we cannot obtain itemTransactions:
			// - Try cancel (same-day, full amount; item breakdown not required)
			// - If cancel fails, try Refund V2 (paymentId-based)
			if (paymentItems.length === 0) {
				const ip = getClientIp(req);
				const fullAmount = remaining;
				const price = toIyzicoPrice(fullAmount);
				if (!price) redirectFail('invalid_amount');

				// 1) Cancel attempt
				try {
					const conversationId = `${orderId}:cancel:${Date.now()}`;
					const result = await iyzicoCancelCreate({
						locale: 'tr',
						conversationId,
						paymentId: String(order.payment_id),
						ip,
					});
					const ok = String(result?.status || '').trim().toLowerCase() === 'success';
					refundAttempts.push({
						paymentTransactionId: `CANCEL:${String(order.payment_id)}`,
						amount: fullAmount,
						currency: String(result?.currency || 'TRY').trim() || 'TRY',
						status: ok ? 'success' : 'failure',
						iyzicoRefundId: result?.cancelHostReference || result?.paymentId || null,
						errorMessage: ok ? null : (result?.errorMessage || 'Cancel failed'),
						raw: result,
					});
					if (ok) {
						refundFinished = await orderModel.finishOrderRefund({ orderId, adminId, refundAttempts });
					} else {
						logger.warn('[shopAdmin] cancel failed; will try refund v2', { orderId, paymentId: order.payment_id, result });
					}
				} catch (err) {
					refundAttempts.push({
						paymentTransactionId: `CANCEL:${String(order.payment_id)}`,
						amount: fullAmount,
						currency: 'TRY',
						status: 'failure',
						iyzicoRefundId: null,
						errorMessage: err?.message || 'Cancel error',
						raw: { message: err?.message, code: err?.code, stack: err?.stack },
					});
				}

				// 2) Refund V2 attempt (paymentId-based)
				if ((refundFinished?.successDelta || 0) <= 0.0001) {
					try {
						const conversationId = `${orderId}:refund_v2:${Date.now()}`;
						const result = await iyzicoRefundV2Create({
							locale: 'tr',
							conversationId,
							paymentId: String(order.payment_id),
							price,
							ip,
							currency: 'TRY',
						});
						const ok = String(result?.status || '').trim().toLowerCase() === 'success';
						refundAttempts.push({
							paymentTransactionId: `REFUND_V2:${String(order.payment_id)}`,
							amount: fullAmount,
							currency: String(result?.currency || 'TRY').trim() || 'TRY',
							status: ok ? 'success' : 'failure',
							iyzicoRefundId: result?.refundHostReference || result?.refundId || result?.paymentId || null,
							errorMessage: ok ? null : (result?.errorMessage || 'Refund v2 failed'),
							raw: result,
						});
						refundFinished = await orderModel.finishOrderRefund({ orderId, adminId, refundAttempts });
					} catch (err) {
						refundAttempts.push({
							paymentTransactionId: `REFUND_V2:${String(order.payment_id)}`,
							amount: fullAmount,
							currency: 'TRY',
							status: 'failure',
							iyzicoRefundId: null,
							errorMessage: err?.message || 'Refund v2 error',
							raw: { message: err?.message, code: err?.code, stack: err?.stack },
						});
					}
				}

				if ((refundFinished?.successDelta || 0) <= 0.0001) {
					const iyzicoRefused = refundAttempts.some((a) => isIyzicoNotRefundableMessage(a?.errorMessage));
					redirectFail(iyzicoRefused ? 'iyzico_not_refundable' : 'missing_items');
				}
			} else {

			const refundedByTxn = await orderModel.getSuccessfulRefundTotalsByTransaction(orderId);
			let remainingToRefund = remaining;
			const plan = [];
			for (const it of paymentItems) {
				if (remainingToRefund <= 0.0001) break;
				const ptid = String(it?.paymentTransactionId || '').trim();
				if (!ptid) continue;
				const itemPaid = Number(it?.paidPrice);
				const itemPrice = Number(it?.price);
				const itemAmount = Number.isFinite(itemPaid) ? itemPaid : (Number.isFinite(itemPrice) ? itemPrice : NaN);
				if (!Number.isFinite(itemAmount) || itemAmount <= 0) continue;
				const already = refundedByTxn.get(ptid) || 0;
				const available = Math.max(0, itemAmount - already);
				if (available <= 0.0001) continue;
				const take = Math.min(available, remainingToRefund);
				if (take <= 0.0001) continue;
				plan.push({ paymentTransactionId: ptid, amount: take, currency: String(it?.currency || 'TRY').trim() || 'TRY' });
				remainingToRefund -= take;
			}
			if (plan.length === 0) redirectFail('nothing_to_refund');

			const ip = getClientIp(req);
			for (const p of plan) {
				const price = toIyzicoPrice(p.amount);
				if (!price) continue;
				const conversationId = `${orderId}:cancel_refund:${Date.now()}`;
				try {
					const result = await iyzicoRefundCreate({
						locale: 'tr',
						conversationId,
						paymentTransactionId: p.paymentTransactionId,
						price,
						ip,
					});
					const ok = String(result?.status || '').trim().toLowerCase() === 'success';
					refundAttempts.push({
						paymentTransactionId: p.paymentTransactionId,
						amount: p.amount,
						currency: p.currency,
						status: ok ? 'success' : 'failure',
						iyzicoRefundId: result?.refundId || result?.paymentId || null,
						errorMessage: ok ? null : (result?.errorMessage || 'Refund failed'),
						raw: result,
					});
				} catch (err) {
					refundAttempts.push({
						paymentTransactionId: p.paymentTransactionId,
						amount: p.amount,
						currency: p.currency,
						status: 'failure',
						iyzicoRefundId: null,
						errorMessage: err?.message || 'Refund error',
						raw: { message: err?.message, code: err?.code, stack: err?.stack },
					});
				}
			}

			refundFinished = await orderModel.finishOrderRefund({
				orderId,
				adminId,
				refundAttempts,
			});
			}
		} else {
			refundFinished = await orderModel.finishOrderRefund({ orderId, adminId, refundAttempts: [] });
		}

		const refundDelta = Number(refundFinished?.successDelta || 0) || 0;
		const remainingAfter = Math.max(0, remaining - refundDelta);
		if (remaining > 0.01 && remainingAfter > 0.01) {
			const e = new Error('Refund not completed; order not cancelled');
			e.code = 'NOT_REFUNDED';
			throw e;
		}

		await orderModel.cancelOrderAfterAdminRefund({ orderId, changedByAdminId: adminId });

		// Real-time notify (best-effort)
		try {
			void (async () => {
				const fullOrder = await orderModel.getOrderWithItems(orderId);
				if (!fullOrder) return;
				const trackingCode = String(fullOrder.tracking_code || '').trim();
				const shopUserId = fullOrder && fullOrder.shop_user_id ? String(fullOrder.shop_user_id) : null;
				const payload = {
					orderId: String(orderId),
					status: 'cancelled',
					trackingCode: trackingCode || null,
				};
				const io = socketService.getIO();
				io.to('adminRoom').emit('orderStatusChanged', payload);
				io.to(`order:${String(orderId)}`).emit('orderStatusChanged', payload);
				if (trackingCode) io.to(`tracking:${trackingCode}`).emit('orderStatusChanged', payload);
				if (shopUserId) io.to(`customer:${shopUserId}`).emit('orderStatusChanged', payload);
			})().catch(() => {});
		} catch {
			// ignore
		}

		businessLogger.logOrder(orderId, adminId, 'ORDER_CANCEL_AND_REFUND', { refunded: refundDelta });

		// Fire-and-forget: notify customer/admin.
		// Keep it to a single email per recipient (cancel email includes refund amount when available).
		try {
			if (!sendEmails) {
				return { ok: true, refundDelta };
			}
			void (async () => {
				const fullOrder = await orderModel.getOrderWithItems(orderId);
				if (!fullOrder) return;

				const customerEmail = String(fullOrder.customer_email || '').trim();
				const customerName = String(fullOrder.customer_full_name || '').trim();
				const customerPhone = String(fullOrder.customer_phone || '').trim();
				const trackingCode = String(fullOrder.tracking_code || '').trim();
				const items = Array.isArray(fullOrder.items) ? fullOrder.items : [];
				const totalAmount = Number(fullOrder.total_amount) || 0;
				const refundDelta = Number(refundFinished?.successDelta || 0) || 0;

				if (customerEmail) {
					const html = await getTemplate('shop/order-cancelled-by-admin-customer', {
						orderId,
						trackingCode,
						customerName,
						items,
						totalAmount,
						refundAmount: refundDelta > 0 ? refundDelta.toFixed(2) : null,
					});
					await sendEmail(customerEmail, 'Siparişiniz İptal Edildi', html, { channel: 'shop' });
				}

				const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
				if (adminEmail) {
					const html = await getTemplate('shop/order-cancelled-by-admin-admin', {
						appBaseUrl: getAppBaseUrl(req),
						orderId,
						trackingCode,
						customerName,
						customerEmail,
						customerPhone,
						items,
						totalAmount,
						refundAmount: refundDelta > 0 ? refundDelta.toFixed(2) : null,
					});
					await sendEmail(adminEmail, `Sipariş İptal + İade (#${orderId})`, html, { channel: 'shop' });
				}
			})().catch((err) => {
				logger.error('[shopAdmin] cancel+refund emails failed', {
					message: err?.message,
					code: err?.code,
					orderId,
					stack: err?.stack,
				});
			});
		} catch {
			// ignore
		}

		return { ok: true, refundDelta };
	} catch (err) {
		if (beginOk) {
			try {
				await orderModel.finishOrderRefund({ orderId, adminId, refundAttempts: [] });
			} catch {
				// ignore
			}
		}
		throw err;
	}
}

async function parseCsvBuffer(buffer) {
	return new Promise((resolve, reject) => {
		const rows = [];
		Readable.from(buffer)
			.pipe(csvParser())
			.on('data', (data) => rows.push(data))
			.on('error', reject)
			.on('end', () => resolve(rows));
	});
}

async function parseXlsxBuffer(buffer) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	const worksheet = workbook.worksheets && workbook.worksheets.length ? workbook.worksheets[0] : null;
	if (!worksheet) return [];

	const headerRow = worksheet.getRow(1);
	const headers = [];
	for (let c = 1; c <= headerRow.cellCount; c += 1) {
		const cell = headerRow.getCell(c);
		headers.push(normalizeHeaderKey(cell && cell.value !== undefined ? cell.value : ''));
	}

	const rows = [];
	worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
		if (rowNumber === 1) return;
		const obj = {};
		for (let c = 1; c <= headers.length; c += 1) {
			const key = headers[c - 1];
			if (!key) continue;
			const cell = row.getCell(c);
			let value = cell && cell.value !== undefined ? cell.value : '';
			if (value && typeof value === 'object' && value.text) value = value.text;
			obj[key] = value;
		}
		rows.push(obj);
	});

	return rows;
}

async function requireShopAdminPage(req, res, next) {
	try {
		if (!req.session || !req.session.adminId) return res.redirect('/login');

		// Cache role in session when available; fall back to DB.
		let role = req.session.adminRole;
		if (!role) {
			const admin = await adminModel.findById(req.session.adminId);
			role = admin ? admin.role : null;
			req.session.adminRole = role;
		}

		if (role === 'admin' || role === 'shop_admin') return next();

		return res.status(403).render('pages/404', {
			title: 'Erişim Reddedildi',
			layout: 'layouts/shopAdmin',
			hideAdminNav: true,
		});
	} catch (err) {
		next(err);
	}
}

function renderLogin(req, res) {
	res.render('shopAdmin/login', {
		title: 'Shop Admin Giriş',
		layout: 'layouts/shopAdmin',
		hideAdminNav: true,
		hideShopAdminNav: true,
		error: req.query.error ? 'E-posta veya şifre hatalı.' : null,
	});
}

async function login(req, res) {
	const email = String(req.body.email || '').trim();
	const password = String(req.body.password || '');
	const admin = await adminModel.findByEmail(email);
	if (!admin) return res.redirect('/login?error=1');

	const ok = await adminModel.verifyPassword({ password, passwordHash: admin.password_hash });
	if (!ok) return res.redirect('/login?error=1');

	req.session.adminId = admin.id;
	req.session.adminRole = admin.role;
	return req.session.save(() => res.redirect('/'));
}

async function logout(req, res) {
	try {
		req.session.destroy(() => {
			res.clearCookie('connect.sid');
			res.redirect('/login');
		});
	} catch {
		res.redirect('/login');
	}
}

async function renderDashboard(req, res, next) {
	try {
		const [products, orders, lowStockProducts, todayStats, monthShopRevenue, topProducts, last7DaysShopRevenue] = await Promise.all([
			shopModel.listProductsAdmin(),
			orderModel.listPaidOrders({ limit: 10 }),
			shopModel.listLowStockProducts({ limit: 8, onlyActive: true }),
			orderModel.getTodayOrderStats(),
			analyticsModel.getShopThisMonthRevenue(),
			analyticsModel.listTopProducts({ limit: 5 }),
			analyticsModel.getLast7DaysShopRevenueSeries(),
		]);
		res.render('shopAdmin/dashboard', {
			title: 'Shop Admin',
			layout: 'layouts/shopAdmin',
			productsCount: products.length,
			orders,
			lowStockProducts,
			todayStats,
			monthShopRevenue,
			topProducts,
			last7DaysShopRevenue,
		});
	} catch (err) {
		next(err);
	}
}

async function renderProducts(req, res, next) {
	try {
		const [products, categories] = await Promise.all([
			shopModel.listProductsAdmin(),
			shopModel.listCategories(),
		]);
		res.render('shopAdmin/products', {
			title: 'Ürünler',
			layout: 'layouts/shopAdmin',
			products,
			categories,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

function downloadBulkProductsTemplate(req, res, next) {
	try {
		const format = String(req.query.format || 'csv').trim().toLowerCase();
		// Şablonda birinci satır Türkçe sütun adları (yükleme sırasında TR/EN ikisi de kabul edilir)
		const headersTR = [
			'Ad', 'Kategori', 'Açıklama',
			'Boyut seçenekleri', 'Renk seçenekleri',
			'Renkler aynı stok', 'Renkler aynı fiyat',
			'Boyut', 'Renk', 'Fiyat', 'Stok',
		];
		const headerKeyMap = {
			'Ad': 'name', 'Kategori': 'category', 'Açıklama': 'description',
			'Boyut seçenekleri': 'size_options', 'Renk seçenekleri': 'color_options',
			'Renkler aynı stok': 'share_stock_across_colors', 'Renkler aynı fiyat': 'share_price_across_colors',
			'Boyut': 'size', 'Renk': 'color', 'Fiyat': 'price', 'Stok': 'stock',
		};
		const exampleRows = [
			{ name: 'NISHMAN Saç Wax', category: 'Saç Şekillendirici', description: 'Sakız kokulu wax.', size_options: '50 ML; 100 ML; 150 ML', color_options: 'Siyah; Beyaz', share_stock_across_colors: 'false', share_price_across_colors: 'false', size: '50 ML', color: 'Siyah', price: '280.00', stock: '10' },
			{ name: 'NISHMAN Saç Wax', category: 'Saç Şekillendirici', description: 'Sakız kokulu wax.', size_options: '50 ML; 100 ML; 150 ML', color_options: 'Siyah; Beyaz', share_stock_across_colors: 'false', share_price_across_colors: 'false', size: '50 ML', color: 'Beyaz', price: '280.00', stock: '12' },
			{ name: 'NISHMAN Saç Wax', category: 'Saç Şekillendirici', description: 'Sakız kokulu wax.', size_options: '50 ML; 100 ML; 150 ML', color_options: 'Siyah; Beyaz', share_stock_across_colors: 'false', share_price_across_colors: 'false', size: '100 ML', color: 'Siyah', price: '340.00', stock: '8' },
			{ name: 'NISHMAN Saç Wax', category: 'Saç Şekillendirici', description: 'Sakız kokulu wax.', size_options: '50 ML; 100 ML; 150 ML', color_options: 'Siyah; Beyaz', share_stock_across_colors: 'false', share_price_across_colors: 'false', size: '100 ML', color: 'Beyaz', price: '340.00', stock: '15' },
		];

		if (format === 'xlsx') {
			void (async () => {
				const workbook = new ExcelJS.Workbook();
				workbook.created = new Date();
				const sheet = workbook.addWorksheet('products');
				sheet.addRow(headersTR);
				for (const row of exampleRows) {
					sheet.addRow(headersTR.map((h) => row[headerKeyMap[h]] ?? ''));
				}
				sheet.getRow(1).font = { bold: true };
				sheet.columns = headersTR.map(() => ({ width: 22 }));

				const buffer = await workbook.xlsx.writeBuffer();
				res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
				res.setHeader('Content-Disposition', 'attachment; filename="products_template.xlsx"');
				return res.status(200).send(Buffer.from(buffer));
			})().catch(next);
			return;
		}

		// CSV: UTF-8 BOM ile Türkçe karakterler Excel'de doğru açılsın
		const csvEscape = (v) => {
			const s = v === undefined || v === null ? '' : String(v);
			if (/["\n\r,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
			return s;
		};
		const line1 = headersTR.map((h) => csvEscape(h)).join(',');
		const dataLines = exampleRows.map((row) => headersTR.map((h) => csvEscape(row[headerKeyMap[h]])).join(','));
		const content = `\ufeff${line1}\n${dataLines.join('\n')}\n`;
		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader('Content-Disposition', 'attachment; filename="products_template.csv"');
		return res.status(200).send(content);
	} catch (err) {
		next(err);
	}
}

async function bulkUpsertProducts(req, res, next) {
	try {
		if (!req.file || !req.file.buffer) return res.redirect('/products?bulk_err=no_file');

		const categories = await shopModel.listCategories();
		const categoryIdSet = new Set((categories || []).map((c) => String(c.id)));
		const categoryNameToId = new Map(
			(categories || [])
				.filter((c) => c && c.name)
				.map((c) => [String(c.name).trim().toLowerCase(), String(c.id)])
		);

		const ext = path.extname(req.file.originalname || '').toLowerCase();
		let rawRows = [];
		if (ext === '.csv') {
			rawRows = await parseCsvBuffer(req.file.buffer);
		} else if (ext === '.xlsx') {
			rawRows = await parseXlsxBuffer(req.file.buffer);
		} else {
			return res.redirect('/products?bulk_err=invalid_file_type');
		}

		const normalized = rawRows.map((r) => normalizeRowKeys(r));
		const requiredCols = ['name', 'price', 'stock', 'description'];
		const optionalCols = ['size', 'color', 'size_options', 'color_options', 'share_stock_across_colors', 'share_price_across_colors'];
		const headerSet = new Set();
		for (const r of normalized) {
			for (const k of Object.keys(r || {})) headerSet.add(k);
		}

		// Aliases (TR -> EN): hem Türkçe hem İngilizce sütun adları kabul edilir
		if (headerSet.has('ad') || headerSet.has('ürün adı')) headerSet.add('name');
		if (headerSet.has('fiyat')) headerSet.add('price');
		if (headerSet.has('stok')) headerSet.add('stock');
		if (headerSet.has('açıklama')) headerSet.add('description');
		if (headerSet.has('boyut')) headerSet.add('size');
		if (headerSet.has('renk')) headerSet.add('color');
		if (headerSet.has('boyut_secenekleri') || headerSet.has('boyut seçenekleri')) headerSet.add('size_options');
		if (headerSet.has('renk_secenekleri') || headerSet.has('renk seçenekleri')) headerSet.add('color_options');
		if (headerSet.has('kategori') || headerSet.has('kategori_adi') || headerSet.has('kategori_adı')) headerSet.add('category');
		if (headerSet.has('category_name')) headerSet.add('category');
		if (headerSet.has('renkler aynı stok') || headerSet.has('stok_renk_paylaşım')) headerSet.add('share_stock_across_colors');
		if (headerSet.has('renkler aynı fiyat') || headerSet.has('fiyat_renk_paylaşım')) headerSet.add('share_price_across_colors');
		for (const c of optionalCols) headerSet.add(c);

		const missingRequired = requiredCols.filter((c) => !headerSet.has(c));
		const hasCategoryId = headerSet.has('category_id');
		const hasCategoryName = headerSet.has('category');
		if (missingRequired.length || (!hasCategoryId && !hasCategoryName)) {
			const missing = [...missingRequired];
			if (!hasCategoryId && !hasCategoryName) missing.push('category_id|category');
			return res.redirect(`/products?bulk_err=missing_columns&missing=${encodeURIComponent(missing.join(','))}`);
		}

		const cellToOptionList = (cell) => {
			if (cell === undefined || cell === null) return undefined;
			if (typeof cell === 'string') return parseOptionList(cell);
			if (typeof cell === 'number') return parseOptionList(String(cell));
			return '__invalid__';
		};

		// First pass: validate each row and resolve categoryId; collect resolved rows
		const resolvedRows = [];
		const invalid = [];
		for (let i = 0; i < normalized.length; i += 1) {
			const row = normalized[i] || {};
			const name = String(row.name ?? row.ad ?? row['ürün adı'] ?? '').trim();
			const price = toNumber(row.price ?? row.fiyat);
			const stock = toInt(row.stock ?? row.stok);
			const description = String(row.description ?? row.açıklama ?? '').trim() || null;
			const categoryIdRaw = String(row.category_id || '').trim();
			let categoryId = categoryIdRaw ? categoryIdRaw : null;
			const categoryNameRaw = row.category ?? row.kategori ?? row.kategori_adi ?? row['kategori_adı'];
			let categoryName = null;
			if (categoryNameRaw !== undefined && categoryNameRaw !== null) {
				if (typeof categoryNameRaw === 'string' || typeof categoryNameRaw === 'number') {
					categoryName = String(categoryNameRaw).trim() || null;
				} else {
					categoryName = '__invalid__';
				}
			}
			const sizeRaw = row.size ?? row.boyut;
			const size = (sizeRaw !== undefined && sizeRaw !== null && (typeof sizeRaw === 'string' || typeof sizeRaw === 'number'))
				? String(sizeRaw).trim() || ''
				: '';
			const colorRaw = row.color ?? row.renk;
			const color = (colorRaw !== undefined && colorRaw !== null && (typeof colorRaw === 'string' || typeof colorRaw === 'number'))
				? String(colorRaw).trim() || ''
				: '';
			const sizeOptionsRaw = row.size_options ?? row.boyut_secenekleri ?? row['boyut seçenekleri'];
			const colorOptionsRaw = row.color_options ?? row.renk_secenekleri ?? row['renk seçenekleri'];
			const sizeOptions = cellToOptionList(sizeOptionsRaw);
			const colorOptions = cellToOptionList(colorOptionsRaw);
			const shareStockRaw = row.share_stock_across_colors ?? row['renkler aynı stok'] ?? row.stok_renk_paylaşım;
			const sharePriceRaw = row.share_price_across_colors ?? row['renkler aynı fiyat'] ?? row.fiyat_renk_paylaşım;
			const shareStockAcrossColors = parseBoolean(shareStockRaw);
			const sharePriceAcrossColors = parseBoolean(sharePriceRaw);

			const reasons = [];
			if (!name) reasons.push('name');
			if (!Number.isFinite(price) || price < 0) reasons.push('price');
			if (!Number.isFinite(stock) || stock < 0) reasons.push('stock');
			if (categoryId !== null && !isUuid(categoryId)) reasons.push('category_id');
			if (categoryId !== null && isUuid(categoryId) && !categoryIdSet.has(categoryId)) reasons.push('category_id_not_found');
			if (categoryName === '__invalid__') reasons.push('category');
			if (categoryId === null && categoryName === null) reasons.push('category');
			if (sizeOptions === '__invalid__') reasons.push('size_options');
			if (colorOptions === '__invalid__') reasons.push('color_options');

			if (reasons.length) {
				invalid.push({ index: i + 2, name, reasons });
				continue;
			}

			if (categoryId === null && categoryName) {
				const key = categoryName.toLowerCase();
				const existingId = categoryNameToId.get(key);
				if (existingId) {
					categoryId = existingId;
				} else {
					try {
						const created = await shopModel.createCategory({ name: categoryName, slug: null });
						if (created && created.id) {
							categoryId = String(created.id);
							categoryIdSet.add(categoryId);
							categoryNameToId.set(key, categoryId);
						}
					} catch {
						invalid.push({ index: i + 2, name, reasons: ['category_create_failed'] });
						continue;
					}
				}
			}

			resolvedRows.push({
				name,
				categoryId,
				description,
				price,
				stock,
				size,
				color,
				sizeOptions: Array.isArray(sizeOptions) ? sizeOptions : (sizeOptions === null ? null : undefined),
				colorOptions: Array.isArray(colorOptions) ? colorOptions : (colorOptions === null ? null : undefined),
				shareStockAcrossColors,
				sharePriceAcrossColors,
				rowIndex: i + 2,
			});
		}

		// Group by (name, categoryId)
		const groupKey = (r) => `${r.name}\n${r.categoryId}`;
		const groups = new Map();
		for (const r of resolvedRows) {
			const key = groupKey(r);
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(r);
		}

		// Build one product per group (simple or variant)
		const candidates = [];
		for (const rows of groups.values()) {
			const first = rows[0];
			const hasVariant = rows.some((r) => (String(r.size || '').trim()) || (String(r.color || '').trim()));

			if (!hasVariant) {
				candidates.push({
					name: first.name,
					categoryId: first.categoryId,
					description: first.description,
					price: first.price,
					stock: first.stock,
					sizeOptions: first.sizeOptions,
					colorOptions: first.colorOptions,
					variants: undefined,
				});
				continue;
			}

			// Variant product: derive size_options / color_options from rows if not from first
			let sizeOptionsArr = Array.isArray(first.sizeOptions) && first.sizeOptions.length ? first.sizeOptions : null;
			let colorOptionsArr = Array.isArray(first.colorOptions) && first.colorOptions.length ? first.colorOptions : null;
			if (!sizeOptionsArr || !colorOptionsArr) {
				const sizesFromRows = [...new Set(rows.map((r) => String(r.size || '').trim()).filter(Boolean))];
				const colorsFromRows = [...new Set(rows.map((r) => String(r.color || '').trim()).filter(Boolean))];
				if (!sizeOptionsArr && sizesFromRows.length) sizeOptionsArr = sizesFromRows;
				if (!colorOptionsArr && colorsFromRows.length) colorOptionsArr = colorsFromRows;
			}
			if (!sizeOptionsArr || !sizeOptionsArr.length) sizeOptionsArr = [''];
			if (!colorOptionsArr || !colorOptionsArr.length) colorOptionsArr = [''];

			const variants = rows.map((r) => ({
				variantKey: buildVariantKey({ selectedSize: r.size || '', selectedColor: r.color || '' }),
				selectedSize: r.size || '',
				selectedColor: r.color || '',
				price: r.price,
				stock: r.stock,
			}));

			const totalStock = variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
			const minPrice = Math.min(...variants.map((v) => Number(v.price) || 0));

			candidates.push({
				name: first.name,
				categoryId: first.categoryId,
				description: first.description,
				price: minPrice,
				stock: totalStock,
				sizeOptions: sizeOptionsArr,
				colorOptions: colorOptionsArr,
				shareStockAcrossColors: first.shareStockAcrossColors,
				sharePriceAcrossColors: first.sharePriceAcrossColors,
				variants,
			});
		}

		const changedByAdminId = req.session ? req.session.adminId : null;
		const result = await shopModel.bulkUpsertProductsByName({
			products: candidates,
			changedByAdminId,
		});

		const added = Number(result?.added) || 0;
		const updated = Number(result?.updated) || 0;
		const invalidCount = invalid.length;
		const invalidPreview = invalid
			.slice(0, 5)
			.map((x) => `#${x.index}:${(x.name || '').slice(0, 40)}(${x.reasons.join('|')})`)
			.join(';');

		const qs = new URLSearchParams();
		qs.set('bulk_ok', '1');
		qs.set('added', String(added));
		qs.set('updated', String(updated));
		qs.set('invalid', String(invalidCount));
		if (invalidPreview) qs.set('invalid_preview', invalidPreview);

		return res.redirect(`/products?${qs.toString()}`);
	} catch (err) {
		next(err);
	}
}

async function renderProductDetail(req, res, next) {
	try {
		const product = await shopModel.getProductById(req.params.id);
		if (!product) {
			return res.status(404).render('pages/404', {
				title: 'Ürün Bulunamadı',
				layout: 'layouts/shopAdmin',
				hideAdminNav: true,
			});
		}
		const stockEvents = await shopModel.listProductStockEvents({ productId: product.id, limit: 50 });
		const productVariants = await shopModel.listProductVariantsAdmin({ productId: product.id });
		res.render('shopAdmin/product', {
			title: 'Ürün Detayı',
			layout: 'layouts/shopAdmin',
			product,
			productVariants,
			stockEvents,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function createProduct(req, res, next) {
	try {
		const buildVariantKey = ({ selectedSize = '', selectedColor = '' } = {}) => JSON.stringify([
			selectedSize == null ? '' : String(selectedSize),
			selectedColor == null ? '' : String(selectedColor),
		]);
		const parseVariantStocksJson = (raw) => {
			if (raw === undefined || raw === null) return undefined;
			if (typeof raw !== 'string') return '__invalid__';
			const trimmed = raw.trim();
			if (!trimmed) return [];
			try {
				const parsed = JSON.parse(trimmed);
				if (!Array.isArray(parsed)) return '__invalid__';
				return parsed;
			} catch {
				return '__invalid__';
			}
		};

		const name = String(req.body.name || '').trim();
		const sizeOptions = parseOptionList(req.body.size_options);
		const colorOptions = parseOptionList(req.body.color_options);
		const variantStocksRaw = parseVariantStocksJson(req.body.variant_stocks_json);
		const description = String(req.body.description || '').trim();
		const stockInputRaw = String(req.body.stock ?? '').trim();
		const stockInput = stockInputRaw === '' ? undefined : Number(stockInputRaw);
		const lowStockThresholdRaw = String(req.body.low_stock_threshold || '').trim();
		const lowStockThreshold = lowStockThresholdRaw === '' ? null : Number(lowStockThresholdRaw);
		const imageUrlFromFile = req.file ? `/public/images/uploads/${req.file.filename}` : null;
		const imageUrlFromInput = String(req.body.image_url || '').trim();
		const imageUrl = imageUrlFromFile || (imageUrlFromInput || null);
		const categoryId = String(req.body.category_id || '').trim() || null;
		const isActive = req.body.is_active === 'on' || req.body.is_active === 'true' || req.body.is_active === true;
		const sharePriceAcrossColors = req.body.share_price_across_colors === 'on'
			|| req.body.share_price_across_colors === 'true'
			|| req.body.share_price_across_colors === true;
		const hasShareField = Object.prototype.hasOwnProperty.call(req.body || {}, 'share_stock_across_colors');
		const shareStockAcrossColors = hasShareField
			? (req.body.share_stock_across_colors === 'on'
				|| req.body.share_stock_across_colors === 'true'
				|| req.body.share_stock_across_colors === true)
			: undefined;

		const sizeArr = Array.isArray(sizeOptions) ? sizeOptions : null;
		const colorArr = Array.isArray(colorOptions) ? colorOptions : null;
		// ShopAdmin policy: size is mandatory and pricing/stock is managed at variant level.
		const hasSizeOptions = Array.isArray(sizeArr) && sizeArr.length > 0;
		if (!hasSizeOptions) return res.redirect('/products?error=1');
		const hasOptions = true;

		let variants = null;
		let stock = 0;
		let derivedMinPrice = null;
		if (hasOptions) {
			if (variantStocksRaw === '__invalid__') return res.redirect('/products?error=1');
			const list = Array.isArray(variantStocksRaw) ? variantStocksRaw : [];
			const stockByKey = new Map();
			const priceByKey = new Map();
			for (const it of list) {
				const key = it && typeof it === 'object' ? String(it.variantKey || it.variant_key || '').trim() : '';
				if (!key) continue;
				const s = Number(it.stock);
				stockByKey.set(key, Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0);
				const pr = it && typeof it === 'object' ? it.price : null;
				const prStr = pr === undefined || pr === null ? '' : String(pr).trim();
				if (!prStr) {
					priceByKey.set(key, null);
				} else {
					const pn = Number(prStr);
					priceByKey.set(key, Number.isFinite(pn) && pn >= 0 ? pn : '__invalid__');
				}
			}
			const sizes = Array.isArray(sizeArr) && sizeArr.length ? sizeArr : [''];
			const colors = Array.isArray(colorArr) && colorArr.length ? colorArr : [''];
			variants = [];
			let total = 0;
			const perSizeShared = new Map();
			let minPrice = null;
			const perSizePrice = new Map();
			for (const s of sizes) {
				for (const c of colors) {
					const vkey = buildVariantKey({ selectedSize: s, selectedColor: c });
					const vStock = stockByKey.has(vkey) ? stockByKey.get(vkey) : 0;
					const vPrice = priceByKey.has(vkey) ? priceByKey.get(vkey) : null;
					if (vPrice === '__invalid__') return res.redirect('/products?error=1');
					// Price is required per variant.
					if (vPrice === null) return res.redirect('/products?error=1');
					if (sharePriceAcrossColors && s) {
						const prev = perSizePrice.get(s);
						if (prev === undefined) perSizePrice.set(s, vPrice);
						else if (Number(prev) !== Number(vPrice)) return res.redirect('/products?error=1');
					}
					if (minPrice === null || vPrice < minPrice) minPrice = vPrice;
					if (shareStockAcrossColors && s) {
						const prev = perSizeShared.get(s) ?? 0;
						perSizeShared.set(s, Math.max(prev, vStock));
					} else {
						total += vStock;
					}
					variants.push({ variantKey: vkey, selectedSize: s || '', selectedColor: c || '', stock: vStock, price: vPrice });
				}
			}
			if (shareStockAcrossColors) {
				for (const v of perSizeShared.values()) total += v;
			}
			stock = total;
			derivedMinPrice = minPrice;
		}

		const price = derivedMinPrice;
		if (
			!name ||
			sizeOptions === '__invalid__' ||
			colorOptions === '__invalid__' ||
			!Number.isFinite(stock) ||
			stock < 0 ||
			!Number.isFinite(price) ||
			price < 0 ||
			(stockInput !== undefined && (!Number.isFinite(stockInput) || stockInput < 0)) ||
			(lowStockThreshold !== null && (!Number.isFinite(lowStockThreshold) || lowStockThreshold < 0))
		) {
			return res.redirect('/products?error=1');
		}

		const created = await shopModel.createProduct({
			name,
			size: null,
			sizeOptions: sizeArr,
			colorOptions: colorArr,
			shareStockAcrossColors,
			sharePriceAcrossColors,
			description: description || null,
			price,
			stock,
			lowStockThreshold,
			imageUrl,
			categoryId,
			isActive,
		});
		if (hasOptions && variants) {
			await shopModel.setProductVariantsAndTotalStock({ id: created.id, variants });
		}
		res.redirect('/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function createCategory(req, res, next) {
	try {
		const name = String(req.body.name || '').trim();
		const slug = String(req.body.slug || '').trim();
		if (!name) return res.redirect('/products?error=1');
		await shopModel.createCategory({ name, slug: slug || null });
		return res.redirect('/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function deleteCategory(req, res, next) {
	try {
		await shopModel.deleteCategory(req.params.id);
		return res.redirect('/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function deleteProduct(req, res, next) {
	try {
		await shopModel.deleteProduct(req.params.id);
		res.redirect('/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function toggleProduct(req, res, next) {
	try {
		await shopModel.setProductActive({
			id: req.params.id,
			isActive: req.body.is_active === 'true' || req.body.is_active === 'on',
		});
		res.redirect('/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function updateProduct(req, res, next) {
	try {
		const buildVariantKey = ({ selectedSize = '', selectedColor = '' } = {}) => JSON.stringify([
			selectedSize == null ? '' : String(selectedSize),
			selectedColor == null ? '' : String(selectedColor),
		]);
		const parseVariantStocksJson = (raw) => {
			if (raw === undefined || raw === null) return undefined;
			if (typeof raw !== 'string') return '__invalid__';
			const trimmed = raw.trim();
			if (!trimmed) return [];
			try {
				const parsed = JSON.parse(trimmed);
				if (!Array.isArray(parsed)) return '__invalid__';
				return parsed;
			} catch {
				return '__invalid__';
			}
		};

		const id = String(req.params.id || '').trim();
		const stockRaw = String(req.body.stock ?? '').trim();
		const stock = stockRaw === '' ? undefined : Number(stockRaw);
		const lowStockThresholdRaw = String(req.body.low_stock_threshold ?? '').trim();
		const lowStockThreshold = lowStockThresholdRaw === '' ? undefined : Number(lowStockThresholdRaw);
		const sizeOptions = parseOptionList(req.body.size_options);
		const colorOptions = parseOptionList(req.body.color_options);
		const variantStocksRaw = parseVariantStocksJson(req.body.variant_stocks_json);
		const imageUrlFromFile = req.file ? `/public/images/uploads/${req.file.filename}` : null;
		const imageUrlFromInput = String(req.body.image_url ?? '').trim();
		const imageUrl = imageUrlFromFile || (imageUrlFromInput ? imageUrlFromInput : undefined);
		const hasShareStockField = Object.prototype.hasOwnProperty.call(req.body || {}, 'share_stock_across_colors');
		const shareStockAcrossColors = hasShareStockField
			? (req.body.share_stock_across_colors === 'on'
				|| req.body.share_stock_across_colors === 'true'
				|| req.body.share_stock_across_colors === true)
			: undefined;
		const hasSharePriceField = Object.prototype.hasOwnProperty.call(req.body || {}, 'share_price_across_colors');
		const sharePriceAcrossColors = hasSharePriceField
			? (req.body.share_price_across_colors === 'on'
				|| req.body.share_price_across_colors === 'true'
				|| req.body.share_price_across_colors === true)
			: undefined;

		const referer = String(req.headers?.referer || '');
		const fromDetail = referer.includes(`/products/${id}`);

		if (
			!id ||
			(stock !== undefined && (!Number.isFinite(stock) || stock < 0)) ||
			(lowStockThreshold !== undefined && (!Number.isFinite(lowStockThreshold) || lowStockThreshold < 0)) ||
			sizeOptions === '__invalid__' ||
			colorOptions === '__invalid__' ||
			variantStocksRaw === '__invalid__'
		) {
			return res.redirect(fromDetail ? `/products/${id}?error=1` : '/products?error=1');
		}

		const sizeArr = sizeOptions === undefined ? undefined : (Array.isArray(sizeOptions) ? sizeOptions : null);
		const colorArr = colorOptions === undefined ? undefined : (Array.isArray(colorOptions) ? colorOptions : null);
		if (sizeArr !== undefined && (!Array.isArray(sizeArr) || sizeArr.length === 0)) {
			// ShopAdmin policy: size options cannot be cleared.
			return res.redirect(fromDetail ? `/products/${id}?error=1` : '/products?error=1');
		}
		let variants = undefined;
		let derivedMinPrice = undefined;
		if (sizeArr !== undefined || colorArr !== undefined || variantStocksRaw !== undefined) {
			const effectiveSizeArr = Array.isArray(sizeArr) ? sizeArr : null;
			const effectiveColorArr = Array.isArray(colorArr) ? colorArr : null;
			const hasOptions = (Array.isArray(effectiveSizeArr) && effectiveSizeArr.length > 0)
				|| (Array.isArray(effectiveColorArr) && effectiveColorArr.length > 0);
			if (!hasOptions) {
				// Clearing options: clear variants but keep manual stock.
				variants = [];
			} else {
				const list = Array.isArray(variantStocksRaw) ? variantStocksRaw : [];
				const stockByKey = new Map();
				const priceByKey = new Map();
				for (const it of list) {
					const key = it && typeof it === 'object' ? String(it.variantKey || it.variant_key || '').trim() : '';
					if (!key) continue;
					const s = Number(it.stock);
					stockByKey.set(key, Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0);
					const pr = it && typeof it === 'object' ? it.price : null;
					const prStr = pr === undefined || pr === null ? '' : String(pr).trim();
					if (!prStr) {
						priceByKey.set(key, null);
					} else {
						const pn = Number(prStr);
						priceByKey.set(key, Number.isFinite(pn) && pn >= 0 ? pn : '__invalid__');
					}
				}
				const sizes = Array.isArray(effectiveSizeArr) && effectiveSizeArr.length ? effectiveSizeArr : [''];
				const colors = Array.isArray(effectiveColorArr) && effectiveColorArr.length ? effectiveColorArr : [''];
				variants = [];
				let minPrice = null;
				for (const s of sizes) {
					for (const c of colors) {
						const vkey = buildVariantKey({ selectedSize: s, selectedColor: c });
						const vStock = stockByKey.has(vkey) ? stockByKey.get(vkey) : 0;
						const vPrice = priceByKey.has(vkey) ? priceByKey.get(vkey) : null;
						if (vPrice === '__invalid__') {
							return res.redirect(fromDetail ? `/products/${id}?error=1` : '/products?error=1');
						}
						if (vPrice === null) {
							return res.redirect(fromDetail ? `/products/${id}?error=1` : '/products?error=1');
						}
						if (minPrice === null || vPrice < minPrice) minPrice = vPrice;
						variants.push({ variantKey: vkey, selectedSize: s || '', selectedColor: c || '', stock: vStock, price: vPrice });
					}
				}
				derivedMinPrice = minPrice === null ? undefined : minPrice;
			}
		}

		const price = derivedMinPrice;

		await shopModel.updateProductAdminFields({
			id,
			stock,
			lowStockThreshold,
			price,
			imageUrl,
			size: undefined,
			sizeOptions: sizeArr,
			colorOptions: colorArr,
			shareStockAcrossColors,
			sharePriceAcrossColors,
			variants,
			changedByAdminId: req.session ? req.session.adminId : null,
		});

		return res.redirect(fromDetail ? `/products/${id}?ok=1` : '/products?ok=1');
	} catch (err) {
		next(err);
	}
}

async function adjustProductStock(req, res, next) {
	try {
		const delta = Number(req.body.delta);
		if (!Number.isFinite(delta) || delta === 0) return res.redirect(`/products/${req.params.id}?error=1`);
		
		await shopModel.adjustProductStock({
			id: req.params.id,
			delta,
			changedByAdminId: req.session ? req.session.adminId : null,
		});
		
		// Stok değişimini logla
		businessLogger.logStock(
			req.params.id,
			'STOCK_ADJUSTED',
			delta,
			{
				adminId: req.session?.adminId,
				action: delta > 0 ? 'increase' : 'decrease',
			}
		);
		
		return res.redirect(`/products/${req.params.id}?ok=1`);
	} catch (err) {
		next(err);
	}
}

async function renderOrders(req, res, next) {
	try {
		// Best-effort: if 3DS redirect/callback failed, sync pending payments so
		// successful orders become visible in the paid-only list.
		try {
			await runOncePaymentSync({ sinceMinutes: 180, limit: 25 });
		} catch {
			// ignore
		}
		let scope = String(req.query?.scope || 'paid').trim().toLowerCase();
		let paymentStatus = String(req.query?.payment || 'all').trim().toLowerCase();
		const orderStatus = String(req.query?.status || 'all').trim().toLowerCase();
		const search = req.query?.q == null ? null : String(req.query.q).trim();

		// Never allow listing payment pending/failed orders in ShopAdmin.
		if (paymentStatus === 'pending' || paymentStatus === 'failed') paymentStatus = 'all';

		// Smart filter: when filtering for non-paid payment states or cancelled orders,
		// automatically switch to history view to avoid surprising empty lists.
		const wantsHistoryByPayment = paymentStatus !== 'all' && paymentStatus !== 'paid';
		const wantsHistoryByOrderStatus = orderStatus === 'cancelled';
		const isExplicitAll = scope === 'all' || scope === 'history';
		if (!isExplicitAll && (wantsHistoryByPayment || wantsHistoryByOrderStatus)) {
			try {
				const sp = new URLSearchParams();
				for (const [k, v] of Object.entries(req.query || {})) {
					if (v == null) continue;
					sp.set(k, String(v));
				}
				sp.set('scope', 'all');
				return res.redirect(`/orders?${sp.toString()}`);
			} catch {
				scope = 'all';
			}
		}
		const orders = await orderModel.listOrdersForShopAdmin({
			limit: 100,
			scope,
			paymentStatus,
			orderStatus,
			search,
		});
		const orderIds = orders.map((o) => o.id);
		const cancelReqRows = await cancellationRequestModel.listActiveCancellationRequestsForOrders(orderIds);
		const cancelRequestsByOrderId = new Map();
		for (const r of cancelReqRows || []) cancelRequestsByOrderId.set(r.order_id, r);
		const items = await orderModel.listOrderItemsForOrders(orderIds);
		const itemsByOrderId = new Map();
		for (const it of items) {
			const list = itemsByOrderId.get(it.order_id) || [];
			list.push(it);
			itemsByOrderId.set(it.order_id, list);
		}
		res.render('shopAdmin/orders', {
			title: 'Siparişler',
			layout: 'layouts/shopAdmin',
			orders,
			itemsByOrderId,
			cancelRequestsByOrderId,
			query: req.query,
			paymentStatusLabelTR,
		});
	} catch (err) {
		next(err);
	}
}

async function renderOrderDetail(req, res, next) {
	try {
		const order = await orderModel.getOrderDetail(req.params.id);
		if (!order) {
			return res.status(404).render('pages/404', {
				title: 'Sipariş Bulunamadı',
				layout: 'layouts/shopAdmin',
				hideAdminNav: true,
			});
		}

		// ShopAdmin lists usually focus on paid orders, but the detail page should remain
		// accessible for lifecycle states like cancelled/refunded (e.g. after approving an
		// "İptal + İade" request). Only block clearly unpaid states.
		const payStatus = String(order.payment_status || '').trim().toLowerCase();
		const allowedPaymentStatuses = new Set(['paid', 'partial_refunded', 'refunded']);
		if (!allowedPaymentStatuses.has(payStatus)) {
			return res.status(404).render('pages/404', {
				title: 'Sipariş Bulunamadı',
				layout: 'layouts/shopAdmin',
				hideAdminNav: true,
			});
		}
		const refunds = await orderModel.listOrderRefunds(req.params.id);
		const cancellationRequest = await cancellationRequestModel.getActiveCancellationRequestForOrder(order.id);
		res.render('shopAdmin/order', {
			title: 'Sipariş Detayı',
			layout: 'layouts/shopAdmin',
			order,
			refunds,
			cancellationRequest,
			rtOrderId: String(order.id || ''),
			rtTrackingCode: String(order.tracking_code || ''),
			query: req.query,
			paymentStatusLabelTR,
		});
	} catch (err) {
		next(err);
	}
}

async function refundOrder(req, res, next) {
	const orderId = String(req.params.id || '').trim();
	const adminId = req.session ? req.session.adminId : null;
	const amountRaw = String(req.body?.amount || '').trim();
	const requestedAmount = amountRaw ? toNumber(amountRaw) : NaN;

	let refundAttempts = [];
	let beginOk = false;
	let finished = null;
	try {
		if (!isUuid(orderId)) return res.redirect(`/orders?refund_err=invalid`);

		const order = await orderModel.beginOrderRefund(orderId);
		beginOk = true;
		const redirectFail = (code) => {
			const e = new Error(code || 'refund_error');
			e.code = code;
			e.redirectTo = `/orders/${encodeURIComponent(orderId)}?refund_err=${encodeURIComponent(code)}`;
			throw e;
		};

		const paymentStatus = String(order.payment_status || '').trim().toLowerCase();
		const orderStatus = String(order.status || '').trim().toLowerCase();
		if (paymentStatus !== 'paid' && paymentStatus !== 'partial_refunded') {
			redirectFail('status');
		}
		if (!order.payment_id) {
			redirectFail('missing_payment_id');
		}

		const total = Number(order.total_amount) || 0;
		const alreadyRefunded = Number(order.refunded_amount) || 0;
		const remaining = Math.max(0, total - alreadyRefunded);
		if (remaining <= 0.01) {
			redirectFail('already_refunded');
		}

		const amount = Number.isFinite(requestedAmount) ? requestedAmount : remaining;
		if (!Number.isFinite(amount) || amount <= 0) {
			redirectFail('invalid_amount');
		}
		if (amount - remaining > 0.01) {
			redirectFail('too_much');
		}

		let paymentItems = Array.isArray(order.payment_items) ? order.payment_items : [];
		if (paymentItems.length === 0) {
			// Backfill: older orders may not have payment_items stored.
			const fetched = await ensureOrderHasPaymentItems({ orderId, paymentId: order.payment_id, paymentToken: order.payment_token });
			paymentItems = fetched.length > 0 ? fetched : [];
			if (paymentItems.length === 0) {
				// Fallback: Refund V2 (paymentId-based). Not ideal for multi-item baskets, but better than blocking refunds.
				const ip = getClientIp(req);
				const price = toIyzicoPrice(amount);
				if (!price) redirectFail('invalid_amount');
				try {
					const conversationId = `${orderId}:refund_v2:${Date.now()}`;
					const result = await iyzicoRefundV2Create({
						locale: 'tr',
						conversationId,
						paymentId: String(order.payment_id),
						price,
						ip,
						currency: 'TRY',
					});
					const ok = String(result?.status || '').trim().toLowerCase() === 'success';
					refundAttempts.push({
						paymentTransactionId: `REFUND_V2:${String(order.payment_id)}`,
						amount,
						currency: String(result?.currency || 'TRY').trim() || 'TRY',
						status: ok ? 'success' : 'failure',
						iyzicoRefundId: result?.refundHostReference || result?.refundId || result?.paymentId || null,
						errorMessage: ok ? null : (result?.errorMessage || 'Refund v2 failed'),
						raw: result,
					});
				} catch (err) {
					refundAttempts.push({
						paymentTransactionId: `REFUND_V2:${String(order.payment_id)}`,
						amount,
						currency: 'TRY',
						status: 'failure',
						iyzicoRefundId: null,
						errorMessage: err?.message || 'Refund v2 error',
						raw: { message: err?.message, code: err?.code, stack: err?.stack },
					});
				}

				finished = await orderModel.finishOrderRefund({
					orderId,
					adminId,
					refundAttempts,
				});
				if ((finished?.successDelta || 0) <= 0.0001) {
					const iyzicoRefused = refundAttempts.some((a) => isIyzicoNotRefundableMessage(a?.errorMessage));
					redirectFail(iyzicoRefused ? 'iyzico_not_refundable' : 'refund_failed');
				}
			}
		}
		if (!finished) {
			const refundedByTxn = await orderModel.getSuccessfulRefundTotalsByTransaction(orderId);

			// Build a per-transaction refund plan.
			let remainingToRefund = amount;
			const plan = [];
			for (const it of paymentItems) {
				if (remainingToRefund <= 0.0001) break;
				const ptid = String(it?.paymentTransactionId || '').trim();
				if (!ptid) continue;
				const itemPaid = Number(it?.paidPrice);
				const itemPrice = Number(it?.price);
				const itemAmount = Number.isFinite(itemPaid) ? itemPaid : (Number.isFinite(itemPrice) ? itemPrice : NaN);
				if (!Number.isFinite(itemAmount) || itemAmount <= 0) continue;
				const already = refundedByTxn.get(ptid) || 0;
				const available = Math.max(0, itemAmount - already);
				if (available <= 0.0001) continue;
				const take = Math.min(available, remainingToRefund);
				if (take <= 0.0001) continue;
				plan.push({ paymentTransactionId: ptid, amount: take, currency: String(it?.currency || 'TRY').trim() || 'TRY' });
				remainingToRefund -= take;
			}

			if (plan.length === 0) {
				redirectFail('nothing_to_refund');
			}

			const ip = getClientIp(req);
			for (const p of plan) {
				const price = toIyzicoPrice(p.amount);
				if (!price) continue;
				const conversationId = `${orderId}:refund:${Date.now()}`;
				try {
					const result = await iyzicoRefundCreate({
						locale: 'tr',
						conversationId,
						paymentTransactionId: p.paymentTransactionId,
						price,
						ip,
					});
					const ok = String(result?.status || '').trim().toLowerCase() === 'success';
					refundAttempts.push({
						paymentTransactionId: p.paymentTransactionId,
						amount: p.amount,
						currency: p.currency,
						status: ok ? 'success' : 'failure',
						iyzicoRefundId: result?.refundId || result?.paymentId || null,
						errorMessage: ok ? null : (result?.errorMessage || 'Refund failed'),
						raw: result,
					});
				} catch (err) {
					refundAttempts.push({
						paymentTransactionId: p.paymentTransactionId,
						amount: p.amount,
						currency: p.currency,
						status: 'failure',
						iyzicoRefundId: null,
						errorMessage: err?.message || 'Refund error',
						raw: { message: err?.message, code: err?.code, stack: err?.stack },
					});
				}
			}

			finished = await orderModel.finishOrderRefund({
				orderId,
				adminId,
				refundAttempts,
			});
		}

		// If we ended up fully refunded while order is still pending, reconcile the lifecycle:
		// - Cancel the order (restock) because it should no longer proceed to shipment.
		// - Close any open cancellation request to avoid persistent "müşteri iptal talebi" badges.
		try {
			const post = await orderModel.getOrderRefundContext(orderId);
			const postStatus = String(post?.status || '').trim().toLowerCase();
			const postPay = String(post?.payment_status || '').trim().toLowerCase();
			if (postPay === 'refunded' && postStatus === 'pending') {
				await orderModel.cancelOrderAfterAdminRefund({ orderId, changedByAdminId: adminId });
			}
			if (postPay === 'refunded') {
				await cancellationRequestModel.approveCancellationRequestsForOrder({
					orderId,
					adminId,
					adminNote: 'İade işlemi tamamlandı.',
				});
			}
		} catch (e) {
			logger.warn('[shopAdmin] refund reconcile step failed (continuing)', {
				message: e?.message,
				code: e?.code,
				orderId,
			});
		}

		businessLogger.logOrder(orderId, adminId, 'ORDER_REFUND', {
			requestedAmount: amount,
			successAmount: finished?.successDelta || 0,
			attempts: refundAttempts.length,
		});

		// Note: reconciliation is handled above (full-refund aware).

		// Fire-and-forget: notify customer/admin about refund.
		try {
			if ((finished?.successDelta || 0) > 0) {
				void (async () => {
					const fullOrder = await orderModel.getOrderWithItems(orderId);
					if (!fullOrder) return;
					const refundAmount = Number(finished.successDelta).toFixed(2);

					const customerEmail = String(fullOrder.customer_email || '').trim();
					if (customerEmail) {
						const html = await getTemplate('shop/order-refund-customer', {
							appBaseUrl: deriveShopBaseUrlFromReq(req),
							orderId,
							trackingCode: String(fullOrder.tracking_code || '').trim(),
							refundAmount,
						});
						await sendEmail(customerEmail, 'Sipariş İadeniz İşleme Alındı', html, { channel: 'shop' });
					}

					const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
					if (adminEmail) {
						const html = await getTemplate('shop/order-refund-admin', {
							appBaseUrl: getAppBaseUrl(req),
							orderId,
							trackingCode: String(fullOrder.tracking_code || '').trim(),
							refundAmount,
							customerName: String(fullOrder.customer_full_name || '').trim(),
							customerEmail,
							customerPhone: String(fullOrder.customer_phone || '').trim(),
							totalAmount: Number(fullOrder.total_amount) || 0,
						});
						await sendEmail(adminEmail, `Sipariş İadesi Yapıldı (#${orderId})`, html, { channel: 'shop' });
					}
				})().catch((err) => {
					logger.error('[shopAdmin] refund email failed', {
						message: err?.message,
						code: err?.code,
						orderId,
						stack: err?.stack,
					});
				});
			}
		} catch {
			// ignore
		}

		return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_ok=1`);
	} catch (err) {
		logger.error('[shopAdmin] refund failed', {
			message: err?.message,
			code: err?.code,
			orderId,
			stack: err?.stack,
		});
		if (beginOk) {
			try {
				await orderModel.finishOrderRefund({ orderId, adminId, refundAttempts: [] });
			} catch {
				// ignore
			}
		}
		if (err?.redirectTo) return res.redirect(err.redirectTo);
		if (err?.code === 'REFUND_IN_PROGRESS') return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=in_progress`);
		const status = err?.statusCode;
		if (status === 404) return res.redirect(`/orders?refund_err=notfound`);
		if (status === 400) return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=invalid`);
		if (status === 409) return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=conflict`);
		return next(err);
	}
}

async function cancelAndRefundOrder(req, res, next) {
	const orderId = String(req.params.id || '').trim();
	const adminId = req.session ? req.session.adminId : null;
	try {
		if (!isUuid(orderId)) return res.redirect(`/orders?refund_err=invalid`);
		await performCancelAndRefund({ req, orderId, adminId });
		// If an order had a pending cancellation request, mark it as approved.
		try {
			await cancellationRequestModel.approveCancellationRequestsForOrder({
				orderId,
				adminId,
				adminNote: 'Admin tarafından iptal + iade işlemi tamamlandı.',
			});
		} catch (e) {
			logger.error('[shopAdmin] cancel+refund succeeded but cancelling request reconcile failed', {
				message: e?.message,
				code: e?.code,
				orderId,
				stack: e?.stack,
			});
		}
		return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_ok=1&ok=1`);
	} catch (err) {
		logger.error('[shopAdmin] cancel+refund failed', {
			message: err?.message,
			code: err?.code,
			orderId,
			stack: err?.stack,
		});
		// performCancelAndRefund already releases refund lock on failures.
		if (err?.redirectTo) return res.redirect(err.redirectTo);
		if (err?.code === 'REFUND_IN_PROGRESS') return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=in_progress`);
		if (err?.code === 'NOT_REFUNDED') return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=not_refunded`);
		if (err?.code === 'ORDER_STATUS') return res.redirect(`/orders/${encodeURIComponent(orderId)}?refund_err=status`);
		return next(err);
	}
}

async function renderCancellationRequests(req, res, next) {
	try {
		const status = String(req.query?.status || 'requested').trim().toLowerCase();
		const search = req.query?.q == null ? null : String(req.query.q).trim();
		const list = await cancellationRequestModel.listCancellationRequests({ status, limit: 100, search });
		res.render('shopAdmin/cancellationRequests', {
			title: 'İptal / İade',
			layout: 'layouts/shopAdmin',
			requests: list,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function renderContactInbox(req, res, next) {
	try {
		const status = String(req.query?.status || 'new').trim().toLowerCase();
		const limitRaw = req.query?.limit == null ? '' : String(req.query.limit).trim();
		const limit = Math.max(1, Math.min(200, Number(limitRaw) || 100));
		const messages = await shopContactModel.listMessages({ status, limit });
		res.render('shopAdmin/contactInbox', {
			title: 'Gelen Kutusu',
			layout: 'layouts/shopAdmin',
			messages,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function renderContactMessageDetail(req, res, next) {
	try {
		const messageId = String(req.params.id || '').trim();
		const message = await shopContactModel.getMessageById(messageId);
		if (!message) return res.redirect('/inbox?err=notfound');

		if (String(message.status || '').trim().toLowerCase() === 'new') {
			try {
				await shopContactModel.setMessageStatus({ messageId, status: 'read' });
				message.status = 'read';
			} catch {
				// non-blocking
			}
		}

		res.render('shopAdmin/contactMessage', {
			title: 'Mesaj Detayı',
			layout: 'layouts/shopAdmin',
			message,
			query: req.query,
		});
	} catch (err) {
		next(err);
	}
}

async function updateContactMessageStatus(req, res, next) {
	try {
		const messageId = String(req.params.id || '').trim();
		const status = String(req.body?.status || 'read').trim().toLowerCase();
		const updated = await shopContactModel.setMessageStatus({ messageId, status });
		if (!updated) return res.redirect('/inbox?err=notfound');

		const returnTo = String(req.body?.returnTo || '').trim().toLowerCase();
		if (returnTo === 'list') return res.redirect('/inbox?ok=1');
		return res.redirect(`/inbox/${encodeURIComponent(messageId)}?ok=1`);
	} catch (err) {
		next(err);
	}
}

async function rejectCancellationRequest(req, res, next) {
	try {
		const requestId = String(req.params.id || '').trim();
		const adminId = req.session ? req.session.adminId : null;
		const note = req.body?.admin_note == null ? null : String(req.body.admin_note).trim();
		if (!isUuid(requestId)) return res.redirect('/cancellation-requests?err=invalid');
		const updated = await cancellationRequestModel.rejectCancellationRequest({ requestId, adminId, adminNote: note });
		if (!updated) return res.redirect('/cancellation-requests?err=status');

		businessLogger.logOrder(updated.order_id, adminId, 'CANCELLATION_REQUEST_REJECTED', {
			requestId,
			adminNote: note || null,
		});

		// Notify customer/admin (best-effort)
		try {
			void (async () => {
				const order = await orderModel.getOrderWithItems(updated.order_id);
				if (!order) return;
				const customerEmail = String(order.customer_email || '').trim();
				const customerName = String(order.customer_full_name || '').trim();
				const trackingCode = String(order.tracking_code || '').trim();
				const items = Array.isArray(order.items) ? order.items : [];
				const totalAmount = Number(order.total_amount) || 0;
				const adminNote = note || null;

				if (customerEmail) {
					const html = await getTemplate('shop/order-cancellation-rejected-customer', {
						appBaseUrl: deriveShopBaseUrlFromReq(req),
						orderId: order.id,
						trackingCode,
						customerName,
						items,
						totalAmount,
						adminNote,
					});
					await sendEmail(customerEmail, 'İptal Talebiniz Güncellendi', html, { channel: 'shop' });
				}

				const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
				if (adminEmail) {
					const html = await getTemplate('shop/order-cancellation-rejected-admin', {
						appBaseUrl: getAppBaseUrl(req),
						orderId: order.id,
						trackingCode,
						customerName,
						customerEmail,
						customerPhone: String(order.customer_phone || '').trim(),
						items,
						totalAmount,
						adminNote,
						requestId,
					});
					await sendEmail(adminEmail, `İptal Talebi Reddedildi (#${order.id})`, html, { channel: 'shop' });
				}

				// Real-time notify (best-effort)
				try {
					const io = socketService.getIO();
					const orderId = String(order.id);
					const trackingCode = String(order.tracking_code || '').trim();
					const shopUserId = order && order.shop_user_id ? String(order.shop_user_id) : null;

					const payload = {
						orderId,
						status: 'rejected',
						trackingCode: trackingCode || null,
						processedAt: new Date().toISOString(),
					};

					io.to('adminRoom').emit('cancellationRequestUpdated', payload);
					io.to(`order:${orderId}`).emit('cancellationRequestUpdated', payload);
					if (trackingCode) io.to(`tracking:${trackingCode}`).emit('cancellationRequestUpdated', payload);
					if (shopUserId) io.to(`customer:${shopUserId}`).emit('cancellationRequestUpdated', payload);
				} catch {
					// ignore
				}
			})();
		} catch {
			// ignore
		}

		return res.redirect(`/orders/${encodeURIComponent(updated.order_id)}?ok=1`);
	} catch (err) {
		next(err);
	}
}

async function approveCancellationRequest(req, res, next) {
	const requestId = String(req.params.id || '').trim();
	const adminId = req.session ? req.session.adminId : null;
	const note = req.body?.admin_note == null ? null : String(req.body.admin_note).trim();
	let orderIdForRedirect = null;
	try {
		if (!isUuid(requestId)) return res.redirect('/cancellation-requests?err=invalid');
		const request = await cancellationRequestModel.getCancellationRequestById(requestId);
		if (!request) return res.redirect('/cancellation-requests?err=notfound');
		if (String(request.status) !== 'requested') return res.redirect('/cancellation-requests?err=status');
		const orderId = String(request.order_id);
		orderIdForRedirect = orderId;

		const cancelRefundResult = await performCancelAndRefund({ req, orderId, adminId, sendEmails: false });
		await cancellationRequestModel.approveCancellationRequestsForOrder({ orderId, adminId, adminNote: note });

		businessLogger.logOrder(orderId, adminId, 'CANCELLATION_REQUEST_APPROVED', {
			requestId,
			adminNote: note || null,
		});

		// Send a single explicit approval email (best-effort).
		try {
			void (async () => {
				const order = await orderModel.getOrderWithItems(orderId);
				if (!order) return;
				const customerEmail = String(order.customer_email || '').trim();
				const customerName = String(order.customer_full_name || '').trim();
				const trackingCode = String(order.tracking_code || '').trim();
				const customerPhone = String(order.customer_phone || '').trim();
				const items = Array.isArray(order.items) ? order.items : [];
				const totalAmount = Number(order.total_amount) || 0;
				const adminNote = note || null;
				const refundDelta = Number(cancelRefundResult?.refundDelta || 0) || 0;
				if (customerEmail) {
					const html = await getTemplate('shop/order-cancellation-approved-customer', {
						appBaseUrl: deriveShopBaseUrlFromReq(req),
						orderId: order.id,
						trackingCode,
						customerName,
						items,
						totalAmount,
						refundAmount: refundDelta > 0.01 ? refundDelta.toFixed(2) : null,
						adminNote,
					});
					await sendEmail(customerEmail, 'İptal Talebiniz Onaylandı', html, { channel: 'shop' });
				}

				const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
				if (adminEmail) {
					const html = await getTemplate('shop/order-cancellation-approved-admin', {
						appBaseUrl: getAppBaseUrl(req),
						orderId: order.id,
						trackingCode,
						customerName,
						customerEmail,
						customerPhone,
						items,
						totalAmount,
						refundAmount: refundDelta > 0.01 ? refundDelta.toFixed(2) : null,
						adminNote,
						requestId,
					});
					await sendEmail(adminEmail, `İptal Talebi Onaylandı (#${order.id})`, html, { channel: 'shop' });
				}

				// Real-time notify (best-effort)
				try {
					const io = socketService.getIO();
					const trackingCode = String(order.tracking_code || '').trim();
					const shopUserId = order && order.shop_user_id ? String(order.shop_user_id) : null;
					const payload = {
						orderId: String(order.id),
						status: 'approved',
						trackingCode: trackingCode || null,
						processedAt: new Date().toISOString(),
					};
					io.to('adminRoom').emit('cancellationRequestUpdated', payload);
					io.to(`order:${String(order.id)}`).emit('cancellationRequestUpdated', payload);
					if (trackingCode) io.to(`tracking:${trackingCode}`).emit('cancellationRequestUpdated', payload);
					if (shopUserId) io.to(`customer:${shopUserId}`).emit('cancellationRequestUpdated', payload);
				} catch {
					// ignore
				}
			})();
		} catch {
			// ignore
		}

		return res.redirect(`/orders/${encodeURIComponent(orderId)}?ok=1`);
	} catch (err) {
		logger.error('[shopAdmin] approveCancellationRequest failed', {
			message: err?.message,
			code: err?.code,
			requestId,
			stack: err?.stack,
		});
		if (err?.redirectTo) return res.redirect(err.redirectTo);
		if (orderIdForRedirect) {
			if (err?.code === 'REFUND_IN_PROGRESS') return res.redirect(`/orders/${encodeURIComponent(orderIdForRedirect)}?refund_err=in_progress`);
			if (err?.code === 'NOT_REFUNDED') return res.redirect(`/orders/${encodeURIComponent(orderIdForRedirect)}?refund_err=not_refunded`);
		}
		return next(err);
	}
}

async function updateOrderStatus(req, res, next) {
	try {
		const newStatus = String(req.body.status || 'pending');
		await orderModel.updateOrderStatus({
			orderId: req.params.id,
			status: newStatus,
			changedByAdminId: req.session ? req.session.adminId : null,
		});

		// Real-time notify (best-effort)
		try {
			const normalized = String(newStatus || '').trim().toLowerCase();
			const orderId = String(req.params.id || '').trim();
			void (async () => {
				const order = await orderModel.getOrderWithItems(orderId);
				if (!order) return;
				const trackingCode = String(order.tracking_code || '').trim();
				const shopUserId = order && order.shop_user_id ? String(order.shop_user_id) : null;
				const payload = {
					orderId,
					status: normalized,
					trackingCode: trackingCode || null,
				};
				const io = socketService.getIO();
				io.to('adminRoom').emit('orderStatusChanged', payload);
				io.to(`order:${orderId}`).emit('orderStatusChanged', payload);
				if (trackingCode) io.to(`tracking:${trackingCode}`).emit('orderStatusChanged', payload);
				if (shopUserId) io.to(`customer:${shopUserId}`).emit('orderStatusChanged', payload);
			})().catch((err) => {
				logger.warn('[socket] orderStatusChanged emit failed (continuing)', {
					message: err?.message,
					code: err?.code,
					orderId,
				});
			});
		} catch {
			// ignore
		}

		// Fire-and-forget: notify customer on important status changes
		try {
			const normalized = String(newStatus || '').trim().toLowerCase();
			if (normalized === 'shipped' || normalized === 'cancelled' || normalized === 'completed') {
				const orderId = req.params.id;
				void (async () => {
					const order = await orderModel.getOrderWithItems(orderId);
					if (!order) return;
					const customerEmail = String(order.customer_email || '').trim();
					if (!customerEmail) return;
					const trackingCode = String(order.tracking_code || '').trim();
					const html = await getTemplate('shop/order-status', {
						appBaseUrl: deriveShopBaseUrlFromReq(req),
						status: normalized,
						trackingCode,
						orderId,
					});
					const subjectByStatus = {
						shipped: 'Siparişiniz Kargoya Verildi',
						cancelled: 'Siparişiniz İptal Edildi',
						completed: 'Siparişiniz Teslim Edildi',
					};
					const subject = subjectByStatus[normalized] || 'Sipariş Durumu Güncellendi';
					await sendEmail(customerEmail, subject, html, { channel: 'shop' });
				})().catch((err) => {
					logger.error('[shopAdmin] order status email failed', {
						message: err?.message,
						code: err?.code,
						orderId,
						newStatus: normalized,
						stack: err?.stack,
					});
				});
			}
		} catch (err) {
			logger.error('[shopAdmin] failed to schedule order status email', {
				message: err?.message,
				code: err?.code,
				stack: err?.stack,
			});
		}
		
		// Sipariş durumu değişikliğini logla
		businessLogger.logOrder(
			req.params.id,
			req.session?.adminId,
			'ORDER_STATUS_UPDATED',
			{
				newStatus,
				adminId: req.session?.adminId,
			}
		);
		
		const redirectTo = req.query && req.query.returnTo === 'detail' ? `/orders/${req.params.id}?ok=1` : '/orders?ok=1';
		res.redirect(redirectTo);
	} catch (err) {
		const returnToDetail = req.query && req.query.returnTo === 'detail';
		const orderId = req.params.id;
		if (err?.code === 'STATUS_LOCKED') {
			return res.redirect(returnToDetail ? `/orders/${encodeURIComponent(orderId)}?err=status_locked` : '/orders?err=status_locked');
		}
		if (err?.code === 'INVALID_STATUS_TRANSITION') {
			return res.redirect(returnToDetail ? `/orders/${encodeURIComponent(orderId)}?err=invalid_transition` : '/orders?err=invalid_transition');
		}
		next(err);
	}
}

/**
 * Export orders to CSV or Excel
 */
async function exportOrders(req, res, next) {
	try {
		const format = String(req.query.format || 'csv').toLowerCase();
		const status = req.query.status || undefined;
		const paymentStatus = req.query.paymentStatus || undefined;
		const startDate = req.query.startDate || undefined;
		const endDate = req.query.endDate || undefined;

		const result = await orderModel.searchOrders({
			status,
			paymentStatus,
			startDate,
			endDate,
			limit: 1000, // Max export limit
		});

		const orders = result.orders || [];

		if (format === 'xlsx' || format === 'excel') {
			// Excel export
			const workbook = new ExcelJS.Workbook();
			const sheet = workbook.addWorksheet('Siparişler');

			sheet.columns = [
				{ header: 'Takip Kodu', key: 'tracking_code', width: 20 },
				{ header: 'Müşteri Adı', key: 'customer_full_name', width: 25 },
				{ header: 'E-posta', key: 'customer_email', width: 30 },
				{ header: 'Telefon', key: 'customer_phone', width: 15 },
				{ header: 'Toplam Tutar', key: 'total_amount', width: 15 },
				{ header: 'İade Tutarı', key: 'refunded_amount', width: 15 },
				{ header: 'Ödeme Durumu', key: 'payment_status', width: 15 },
				{ header: 'Sipariş Durumu', key: 'status', width: 15 },
				{ header: 'Tarih', key: 'created_at', width: 20 },
				{ header: 'Adres', key: 'shipping_address', width: 40 },
			];

			orders.forEach((order) => {
				sheet.addRow({
					tracking_code: order.tracking_code || '-',
					customer_full_name: order.customer_full_name || '-',
					customer_email: order.customer_email || '-',
					customer_phone: order.customer_phone || '-',
					total_amount: Number(order.total_amount) || 0,
					refunded_amount: Number(order.refunded_amount) || 0,
					payment_status: paymentStatusLabelTR(order.payment_status),
					status: order.status === 'pending' ? 'Bekliyor' :
						order.status === 'shipped' ? 'Kargoda' :
						order.status === 'completed' ? 'Tamamlandı' :
						order.status === 'cancelled' ? 'İptal' : order.status,
					created_at: order.created_at ? new Date(order.created_at).toLocaleString('tr-TR') : '-',
					shipping_address: order.shipping_address || '-',
				});
			});

			res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
			res.setHeader('Content-Disposition', `attachment; filename=siparisler_${Date.now()}.xlsx`);

			await workbook.xlsx.write(res);
			res.end();
		} else {
			// CSV export
			const header = [
				'Takip Kodu',
				'Müşteri Adı',
				'E-posta',
				'Telefon',
				'Toplam Tutar',
				'İade Tutarı',
				'Ödeme Durumu',
				'Sipariş Durumu',
				'Tarih',
				'Adres',
			].join(',');

			const rows = orders.map((order) => {
				return [
					order.tracking_code || '-',
					`"${String(order.customer_full_name || '-').replace(/"/g, '""')}"`,
					order.customer_email || '-',
					order.customer_phone || '-',
					Number(order.total_amount) || 0,
					Number(order.refunded_amount) || 0,
					paymentStatusLabelTR(order.payment_status),
					order.status === 'pending' ? 'Bekliyor' :
						order.status === 'shipped' ? 'Kargoda' :
						order.status === 'completed' ? 'Tamamlandı' :
						order.status === 'cancelled' ? 'İptal' : order.status,
					order.created_at ? new Date(order.created_at).toLocaleString('tr-TR') : '-',
					`"${String(order.shipping_address || '-').replace(/"/g, '""')}"`,
				].join(',');
			});

			const csv = [header, ...rows].join('\n');
			const bom = '\uFEFF'; // UTF-8 BOM for Excel compatibility

			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader('Content-Disposition', `attachment; filename=siparisler_${Date.now()}.csv`);
			res.send(bom + csv);
		}
	} catch (err) {
		next(err);
	}
}

/**
 * Get payment report data (API)
 */
async function getPaymentReportApi(req, res, next) {
	try {
		const startDate = req.query.startDate || undefined;
		const endDate = req.query.endDate || undefined;

		const [report, dailySeries, methodStats] = await Promise.all([
			analyticsModel.getPaymentReport({ startDate, endDate }),
			analyticsModel.getDailyPaymentSeries({ startDate, endDate }),
			analyticsModel.getPaymentMethodStats({ startDate, endDate }),
		]);

		res.json({
			ok: true,
			report,
			dailySeries,
			methodStats,
		});
	} catch (err) {
		next(err);
	}
}

/**
 * Get advanced analytics data (API)
 */
async function getAdvancedAnalyticsApi(req, res, next) {
	try {
		const [
			customerStats,
			topCustomers,
			categoryStats,
			hourlyDistribution,
			conversionFunnel,
			inventoryAlerts,
		] = await Promise.all([
			analyticsModel.getCustomerStats(),
			analyticsModel.getTopCustomers({ limit: 10 }),
			analyticsModel.getCategoryStats(),
			analyticsModel.getHourlyOrderDistribution(),
			analyticsModel.getConversionFunnel(),
			analyticsModel.getInventoryAlerts(),
		]);

		res.json({
			ok: true,
			customerStats,
			topCustomers,
			categoryStats,
			hourlyDistribution,
			conversionFunnel,
			inventoryAlerts,
		});
	} catch (err) {
		next(err);
	}
}

/**
 * Search orders with advanced filters (API)
 */
async function searchOrdersApi(req, res, next) {
	try {
		const { status, paymentStatus, startDate, endDate, minAmount, maxAmount, q, limit, offset } = req.query;

		const result = await orderModel.searchOrders({
			status,
			paymentStatus,
			startDate,
			endDate,
			minAmount: minAmount !== undefined ? Number(minAmount) : undefined,
			maxAmount: maxAmount !== undefined ? Number(maxAmount) : undefined,
			searchQuery: q,
			limit: Number(limit) || 50,
			offset: Number(offset) || 0,
		});

		res.json({
			ok: true,
			orders: result.orders,
			total: result.total,
			limit: result.limit,
			offset: result.offset,
		});
	} catch (err) {
		next(err);
	}
}

module.exports = {
	requireShopAdminPage,
	renderLogin,
	login,
	logout,
	renderDashboard,
	renderProducts,
	downloadBulkProductsTemplate,
	renderProductDetail,
	createProduct,
	bulkUpsertProducts,
	updateProduct,
	adjustProductStock,
	deleteProduct,
	toggleProduct,
	createCategory,
	deleteCategory,
	renderOrders,
	renderOrderDetail,
	updateOrderStatus,
	refundOrder,
	cancelAndRefundOrder,
	renderContactInbox,
	renderContactMessageDetail,
	updateContactMessageStatus,
	renderCancellationRequests,
	approveCancellationRequest,
	rejectCancellationRequest,
	// New exports
	exportOrders,
	getPaymentReportApi,
	getAdvancedAnalyticsApi,
	searchOrdersApi,
};
