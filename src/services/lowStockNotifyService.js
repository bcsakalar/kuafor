const { sendEmail, getTemplate } = require('./emailService');
const { getContactNotifyToEmail, getShopNotifyToEmail } = require('../config/email');
const { logger } = require('../config/logger');

function isNotifyEnabled() {
	return String(process.env.SHOP_LOW_STOCK_NOTIFY_EMAIL || '1') === '1';
}

function getAdminEmail() {
	return String(getShopNotifyToEmail() || getContactNotifyToEmail() || process.env.ADMIN_EMAIL || '').trim();
}

function toInt(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

async function notifyLowStockCrossingAdmin({ productId, productName, stock, threshold } = {}) {
	try {
		if (!isNotifyEnabled()) return { sent: false, reason: 'disabled' };
		const adminEmail = getAdminEmail();
		if (!adminEmail) return { sent: false, reason: 'missing_admin_email' };

		const safeId = String(productId || '').trim();
		if (!safeId) return { sent: false, reason: 'missing_product_id' };

		const safeName = String(productName || '').trim();
		const safeStock = toInt(stock, null);
		const safeThreshold = toInt(threshold, 5);

		const subject = safeName
			? `Düşük Stok Uyarısı: ${safeName}`
			: `Düşük Stok Uyarısı (#${safeId})`;

		const html = await getTemplate('shop/low-stock-admin', {
			productId: safeId,
			productName: safeName || null,
			stock: safeStock,
			threshold: safeThreshold,
		});

		await sendEmail(adminEmail, subject, html, { channel: 'shop' });
		return { sent: true };
	} catch (err) {
		logger.warn('[shop] low stock notify email failed (continuing)', {
			message: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
		return { sent: false, reason: 'error', error: err };
	}
}

module.exports = {
	notifyLowStockCrossingAdmin,
};
