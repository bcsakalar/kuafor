const { iyzico } = require('../config/iyzico');

function normalizeString(value) {
	return String(value == null ? '' : value).trim();
}

function toIyzicoPrice(value, { inKurus = false } = {}) {
	let n;
	if (typeof value === 'string') {
		const s = value.trim();
		if (!s) return '0.00';
		n = Number(s.replace(',', '.'));
	} else {
		n = Number(value);
	}
	if (!Number.isFinite(n)) return '0.00';
	if (inKurus) n = n / 100;
	if (n < 0) return '0.00';
	return (Math.round(n * 100) / 100).toFixed(2);
}

function ensureResponsiveCheckoutFormContent(content) {
	return String(content || '');
}

function extractIyzicoError(src) {
	const s = src || {};
	return {
		errorCode: s.errorCode || s.code || s.error_code || null,
		errorMessage: s.errorMessage || s.message || s.error_message || null,
		errorGroup: s.errorGroup || s.error_group || null,
		raw: s,
	};
}

function requireField(name, value) {
	if (!value) {
		const err = new Error(`Missing required field: ${name}`);
		err.code = 'IYZICO_REQUIRED_FIELD';
		err.field = name;
		throw err;
	}
}

function buildCallbackUrl({ callbackUrl, baseUrl }) {
	const direct = normalizeString(callbackUrl);
	if (direct) return direct;
	const base = normalizeString(baseUrl)
		|| normalizeString(process.env.SHOP_BASE_URL)
		|| normalizeString(process.env.APP_BASE_URL);
	if (!base) {
		const err = new Error('Missing base URL for callbackUrl');
		err.code = 'IYZICO_CALLBACK_URL_MISSING';
		throw err;
	}
	const trimmed = base.replace(/\/+$/, '');
	return `${trimmed}/payment-callback`;
}

function buildBasketItems(items, { priceInKurus = false } = {}) {
	const list = Array.isArray(items) ? items : [];
	if (list.length === 0) {
		const err = new Error('Basket items are empty');
		err.code = 'IYZICO_EMPTY_BASKET';
		throw err;
	}
	return list.map((item, index) => {
		const id = normalizeString(item.id || item.productId || item.sku || String(index + 1));
		const name = normalizeString(item.name || item.title);
		const category1 = normalizeString(item.category1 || item.category || item.categoryName);
		const category2 = normalizeString(item.category2 || item.subCategory || '');
		const itemType = normalizeString(item.itemType || 'PHYSICAL') || 'PHYSICAL';
		const qty = Number(item.quantity == null ? 1 : item.quantity);
		const hasQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
		const unitPriceRaw = item.unitPrice ?? item.price ?? item.amount ?? item.linePrice ?? item.lineTotal;
		const linePriceRaw = item.lineTotal != null ? item.lineTotal : (Number(unitPriceRaw) * hasQty);
		const inKurus = item.priceInKurus == null ? priceInKurus : Boolean(item.priceInKurus);
		const price = toIyzicoPrice(linePriceRaw, { inKurus });

		requireField('basketItems.id', id);
		requireField('basketItems.name', name);
		requireField('basketItems.category1', category1);
		requireField('basketItems.price', price);

		return {
			id,
			name,
			category1,
			...(category2 ? { category2 } : {}),
			itemType,
			price,
		};
	});
}

function createCheckoutForm({
	cartItems,
	buyer,
	shippingAddress,
	billingAddress,
	conversationId,
	basketId,
	price,
	paidPrice,
	priceInKurus = false,
	locale = 'tr',
	currency = 'TRY',
	paymentGroup = 'PRODUCT',
	enabledInstallments = [1, 2, 3, 6, 9],
	callbackUrl,
	callbackBaseUrl,
} = {}) {
	const basketItems = buildBasketItems(cartItems, { priceInKurus });
	const calcTotal = basketItems
		.reduce((sum, it) => sum + (Number(it.price) || 0), 0);
	const finalPrice = toIyzicoPrice(price ?? calcTotal, { inKurus: priceInKurus });
	const finalPaidPrice = toIyzicoPrice(paidPrice ?? finalPrice, { inKurus: priceInKurus });

	const buyerPayload = {
		id: normalizeString(buyer?.id),
		name: normalizeString(buyer?.name),
		surname: normalizeString(buyer?.surname),
		gsmNumber: normalizeString(buyer?.gsmNumber || buyer?.phone),
		email: normalizeString(buyer?.email),
		identityNumber: normalizeString(buyer?.identityNumber),
		registrationAddress: normalizeString(buyer?.registrationAddress || buyer?.address),
		ip: normalizeString(buyer?.ip),
		city: normalizeString(buyer?.city),
		country: normalizeString(buyer?.country || 'Turkey'),
	};

	requireField('buyer.id', buyerPayload.id);
	requireField('buyer.name', buyerPayload.name);
	requireField('buyer.surname', buyerPayload.surname);
	requireField('buyer.gsmNumber', buyerPayload.gsmNumber);
	requireField('buyer.email', buyerPayload.email);
	requireField('buyer.identityNumber', buyerPayload.identityNumber);
	requireField('buyer.registrationAddress', buyerPayload.registrationAddress);
	requireField('buyer.ip', buyerPayload.ip);
	requireField('buyer.city', buyerPayload.city);
	requireField('buyer.country', buyerPayload.country);

	const shippingPayload = {
		contactName: normalizeString(shippingAddress?.contactName || shippingAddress?.fullName || shippingAddress?.name),
		city: normalizeString(shippingAddress?.city),
		country: normalizeString(shippingAddress?.country || 'Turkey'),
		address: normalizeString(shippingAddress?.address),
		zipCode: normalizeString(shippingAddress?.zipCode || shippingAddress?.postalCode || '00000'),
	};

	const billingPayload = {
		contactName: normalizeString(billingAddress?.contactName || shippingPayload.contactName),
		city: normalizeString(billingAddress?.city || shippingPayload.city),
		country: normalizeString(billingAddress?.country || shippingPayload.country),
		address: normalizeString(billingAddress?.address || shippingPayload.address),
		zipCode: normalizeString(billingAddress?.zipCode || shippingPayload.zipCode || '00000'),
	};

	requireField('shippingAddress.contactName', shippingPayload.contactName);
	requireField('shippingAddress.city', shippingPayload.city);
	requireField('shippingAddress.country', shippingPayload.country);
	requireField('shippingAddress.address', shippingPayload.address);

	requireField('billingAddress.contactName', billingPayload.contactName);
	requireField('billingAddress.city', billingPayload.city);
	requireField('billingAddress.country', billingPayload.country);
	requireField('billingAddress.address', billingPayload.address);

	const callback = buildCallbackUrl({
		callbackUrl,
		baseUrl: callbackBaseUrl,
	});

	return {
		locale,
		conversationId: normalizeString(conversationId || basketId || buyerPayload.id),
		price: finalPrice,
		paidPrice: finalPaidPrice,
		currency,
		basketId: normalizeString(basketId || conversationId || buyerPayload.id),
		paymentGroup,
		callbackUrl: callback,
		enabledInstallments,
		buyer: buyerPayload,
		shippingAddress: shippingPayload,
		billingAddress: billingPayload,
		basketItems,
	};
}

function isHostedPaymentAvailable() {
	return Boolean(iyzico?.payWithIyzicoInitialize?.create);
}

function checkoutFormInitialize(requestBody) {
	return new Promise((resolve, reject) => {
		try {
			if (!iyzico?.checkoutFormInitialize?.create) {
				const err = new Error('iyzico.checkoutFormInitialize.create is not available');
				err.code = 'IYZICO_CHECKOUTFORMINIT_UNAVAILABLE';
				return reject(err);
			}
			iyzico.checkoutFormInitialize.create(requestBody, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

function checkoutFormRetrieve(requestBody) {
	return new Promise((resolve, reject) => {
		try {
			if (!iyzico?.checkoutForm?.retrieve) {
				const err = new Error('iyzico.checkoutForm.retrieve is not available');
				err.code = 'IYZICO_CHECKOUTFORM_RETRIEVE_UNAVAILABLE';
				return reject(err);
			}
			iyzico.checkoutForm.retrieve(requestBody, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

function paymentRetrieve(requestBody) {
	return new Promise((resolve, reject) => {
		try {
			if (!iyzico?.payment?.retrieve) {
				const err = new Error('iyzico.payment.retrieve is not available');
				err.code = 'IYZICO_PAYMENT_RETRIEVE_UNAVAILABLE';
				return reject(err);
			}
			iyzico.payment.retrieve(requestBody, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

function payWithIyzicoInitialize(requestBody) {
	return new Promise((resolve, reject) => {
		try {
			if (!iyzico?.payWithIyzicoInitialize?.create) {
				const err = new Error('iyzico.payWithIyzicoInitialize.create is not available');
				err.code = 'IYZICO_PAYWITHIYZICO_UNAVAILABLE';
				return reject(err);
			}
			iyzico.payWithIyzicoInitialize.create(requestBody, (err, result) => {
				if (err) return reject(err);
				return resolve(result);
			});
		} catch (e) {
			reject(e);
		}
	});
}

module.exports = {
	toIyzicoPrice,
	ensureResponsiveCheckoutFormContent,
	extractIyzicoError,
	createCheckoutForm,
	isHostedPaymentAvailable,
	checkoutFormInitialize,
	checkoutFormRetrieve,
	paymentRetrieve,
	payWithIyzicoInitialize,
};
