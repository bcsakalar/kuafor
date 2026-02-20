const { checkoutFormRetrieve, extractIyzicoError } = require('./iyzicoPaymentService');
const orderModel = require('../models/orderModel');
const cartModel = require('../models/cartModel');
const settingsModel = require('../models/settingsModel');
const { getTemplate, sendEmail } = require('./emailService');
const { generateInvoicePdfForOrder } = require('./invoicePdfService');
const { getContactNotifyToEmail, getInfoEmail, getShopNotifyToEmail } = require('../config/email');
const { logger } = require('../config/logger');

function normalizePaymentStatus(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	return raw.toUpperCase();
}

function resolveBaseUrl() {
	const shopBase = String(process.env.SHOP_BASE_URL || '').trim();
	if (shopBase) return shopBase;
	const appBase = String(process.env.APP_BASE_URL || '').trim();
	return appBase || '';
}

function toNumberTR(value) {
	const raw = value === undefined || value === null ? '' : String(value).trim();
	if (!raw) return NaN;
	const n = Number(raw.replace(',', '.'));
	return Number.isFinite(n) ? n : NaN;
}

async function finalizeOrder({ token }) {
	const paymentToken = String(token || '').trim();
	if (!paymentToken) {
		const err = new Error('Missing payment token');
		err.code = 'MISSING_TOKEN';
		throw err;
	}

	let retrieved;
	try {
		retrieved = await checkoutFormRetrieve({ locale: 'tr', token: paymentToken });
	} catch (err) {
		logger.error('[orderService] iyzico retrieve failed', {
			message: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
		throw err;
	}

	const status = String(retrieved?.status || '').trim().toLowerCase();
	const paymentStatus = normalizePaymentStatus(retrieved?.paymentStatus);
	const orderId = String(retrieved?.conversationId || retrieved?.basketId || '').trim();
	const paymentId = String(retrieved?.paymentId || '').trim() || null;

	if (!orderId) {
		const err = new Error('Order id not found in payment response');
		err.code = 'ORDER_ID_MISSING';
		throw err;
	}

	const orderPay = await orderModel.getOrderPaymentInfo(orderId);
	if (!orderPay) {
		const err = new Error('Order not found');
		err.code = 'ORDER_NOT_FOUND';
		throw err;
	}

	// Token mismatch protection
	const storedToken = String(orderPay.payment_token || '').trim();
	if (storedToken && storedToken !== paymentToken) {
		try {
			await orderModel.setOrderPaymentFailureDetails({
				orderId,
				paymentId,
				errorCode: 'TOKEN_MISMATCH',
				errorMessage: 'Token doğrulaması başarısız (sipariş ile eşleşmiyor).',
				errorGroup: 'SECURITY',
				raw: { token: paymentToken, storedToken },
			});
		} catch {
			// ignore
		}
		return { ok: false, orderId, paymentStatus: 'TOKEN_MISMATCH' };
	}

	if (status !== 'success' || paymentStatus !== 'SUCCESS') {
		try {
			const e = extractIyzicoError(retrieved);
			await orderModel.setOrderPaymentFailureDetails({
				orderId,
				paymentId,
				errorCode: e.errorCode || 'PAYMENT_FAILED',
				errorMessage: e.errorMessage || 'Payment not successful',
				errorGroup: e.errorGroup || 'IYZICO',
				raw: e.raw,
			});
		} catch (err) {
			logger.error('[orderService] payment failure update failed', {
				orderId,
				message: err?.message,
				code: err?.code,
			});
		}
		return { ok: false, orderId, paymentStatus };
	}

	// Amount verification
	const paidPrice = toNumberTR(retrieved?.paidPrice);
	const orderTotal = Number(orderPay.total_amount);
	if (Number.isFinite(paidPrice) && Number.isFinite(orderTotal)) {
		const diff = Math.abs(paidPrice - orderTotal);
		if (diff > 0.01) {
			try {
				await orderModel.setOrderPaymentFailureDetails({
					orderId,
					paymentId,
					errorCode: 'AMOUNT_MISMATCH',
					errorMessage: `PaidPrice (${paidPrice}) ile OrderTotal (${orderTotal}) uyuşmuyor.`,
					errorGroup: 'SECURITY',
					raw: { paidPrice, orderTotal, retrieved },
				});
			} catch {
				// ignore
			}
			return { ok: false, orderId, paymentStatus: 'AMOUNT_MISMATCH' };
		}
	}

	// Persist payment items for refund operations
	try {
		const rawItems =
			(Array.isArray(retrieved?.paymentItems) ? retrieved.paymentItems : null)
			|| (Array.isArray(retrieved?.itemTransactions) ? retrieved.itemTransactions : null)
			|| (Array.isArray(retrieved?.itemTransactionList) ? retrieved.itemTransactionList : null)
			|| (Array.isArray(retrieved?.itemTransaction) ? retrieved.itemTransaction : null)
			|| [];
		const paymentItems = rawItems
			.map((it) => ({
				paymentTransactionId: String(it?.paymentTransactionId || '').trim(),
				paidPrice: toNumberTR(it?.paidPrice),
				price: toNumberTR(it?.price),
				currency: String(retrieved?.currency || it?.currency || 'TRY').trim() || 'TRY',
			}))
			.filter((x) => x.paymentTransactionId);
		if (paymentItems.length > 0) {
			await orderModel.setOrderPaymentItems({ orderId, paymentItems });
		}
	} catch {
		// ignore
	}

	let finalizeResult;
	try {
		finalizeResult = await orderModel.finalizePaidOrderAndDecrementStock({ orderId, paymentId });
	} catch (err) {
		logger.error('[orderService] finalizePaidOrderAndDecrementStock failed', {
			orderId,
			message: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
		throw err;
	}

	let order;
	try {
		order = await orderModel.getOrderWithItems(orderId);
	} catch (err) {
		logger.error('[orderService] getOrderWithItems failed', {
			orderId,
			message: err?.message,
			code: err?.code,
		});
	}

	// Clear cart (only if we can identify a shop user)
	try {
		const shopUserId = order && order.shop_user_id ? String(order.shop_user_id) : '';
		if (shopUserId) {
			await cartModel.clearCart(shopUserId);
		}
	} catch (err) {
		logger.error('[orderService] clearCart failed', {
			orderId,
			message: err?.message,
			code: err?.code,
		});
	}

	// Send emails only when we just finalized (not when order was already paid) — avoids duplicate emails from callback + polling / order-success
	try {
		if (order && finalizeResult && !finalizeResult.alreadyPaid) {
			const baseUrl = resolveBaseUrl();
			const customerEmail = String(order.customer_email || '').trim();
			const customerName = String(order.customer_full_name || '').trim();
			const trackingCode = String(order.tracking_code || '').trim();
			const items = Array.isArray(order.items) ? order.items : [];
			const totalAmount = Number(order.total_amount) || 0;
			const shippingAddress = String(order.shipping_address || '').trim();
			const customerPhone = String(order.customer_phone || '').trim();

			const emailJobs = [];

			if (customerEmail) {
				emailJobs.push(async () => {
					const html = await getTemplate('shop/order-confirmation', {
						appBaseUrl: baseUrl,
						orderId: order.id,
						trackingCode,
						customerName,
						items,
						totalAmount,
						shippingAddress,
					});
					let attachments = [];
					try {
						const company = await settingsModel.getCompanySettings();
						const pdfBuffer = await generateInvoicePdfForOrder(order, company);
						if (pdfBuffer && pdfBuffer.length > 0) {
							const fileName = `E-Fatura-${trackingCode || order.id}.pdf`.replace(/[^\w\-\.]/g, '-');
							attachments = [{ content: pdfBuffer, name: fileName }];
						}
					} catch (attachErr) {
						logger.warn('[orderService] invoice PDF attach failed (sending email without attachment)', {
							orderId: order.id,
							message: attachErr?.message,
							code: attachErr?.code,
						});
					}
					await sendEmail(customerEmail, 'Sipariş Onayı', html, { channel: 'shop', attachments });
				});
			}

			const adminEmail = String(getShopNotifyToEmail() || getContactNotifyToEmail() || getInfoEmail() || process.env.ADMIN_EMAIL || '').trim();
			if (adminEmail) {
				emailJobs.push(async () => {
					const html = await getTemplate('shop/new-order-admin', {
						appBaseUrl: baseUrl,
						orderId: order.id,
						trackingCode,
						customerName,
						customerEmail,
						customerPhone,
						items,
						totalAmount,
						shippingAddress,
					});
					await sendEmail(adminEmail, `Yeni Sipariş (#${orderId})`, html, { channel: 'shop' });
				});
			} else {
				logger.warn('[orderService] admin notify email missing; new order email skipped', {
					orderId,
					hint: 'Set SHOP_NOTIFY_TO_EMAIL or CONTACT_NOTIFY_TO_EMAIL (or EMAIL_INFO_EMAIL/ADMIN_EMAIL fallback).',
				});
			}

			if (emailJobs.length > 0) {
				void Promise.allSettled(emailJobs.map((job) => job()))
					.then((results) => {
						results.forEach((result) => {
							if (result.status === 'rejected') {
								const err = result.reason;
								logger.error('[orderService] order email failed', {
									orderId,
									message: err?.message,
									code: err?.code,
									stack: err?.stack,
								});
							}
						});
					})
					.catch((err) => {
						logger.error('[orderService] order email failed', {
							orderId,
							message: err?.message,
							code: err?.code,
							stack: err?.stack,
						});
					});
			}
		}
	} catch (err) {
		logger.error('[orderService] order email setup failed', {
			orderId,
			message: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
	}

	return {
		ok: true,
		orderId,
		trackingCode: finalizeResult?.trackingCode || null,
		paidAmount: finalizeResult?.totalAmount || null,
	};
}

module.exports = {
	finalizeOrder,
};
