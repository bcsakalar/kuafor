function paymentStatusLabelTR(paymentStatus) {
	const ps = String(paymentStatus || '').trim().toLowerCase();
	if (ps === 'paid') return 'Ödendi';
	if (ps === 'failed') return 'Başarısız';
	if (ps === 'partial_refunded') return 'Kısmi İade';
	if (ps === 'refunded') return 'İade Edildi';
	return 'Beklemede';
}

function orderStageLabelTR(status) {
	const s = String(status || '').trim().toLowerCase();
	if (s === 'cancelled') return 'İptal Edildi';
	if (s === 'completed') return 'Teslim Edildi';
	if (s === 'shipped') return 'Kargoya Verildi';
	if (s === 'pending') return 'Sipariş Alındı';
	return String(status || '').trim() || '—';
}

function cancellationRequestTextTR(status) {
	const s = String(status || '').trim().toLowerCase();
	if (s === 'approved') return 'İptal Talebi Onaylandı';
	if (s === 'rejected') return 'İptal Talebi Reddedildi';
	if (s === 'cancelled') return 'İptal Talebi İptal';
	if (s === 'requested') return 'İptal Talebi Alındı';
	return 'İptal Talebi Alındı';
}

function cancellationRequestBadgeTR(status) {
	const s = String(status || '').trim().toLowerCase();
	if (s === 'rejected' || s === 'cancelled') return { text: cancellationRequestTextTR(s), cls: 'ui-muted' };
	return { text: cancellationRequestTextTR(s), cls: 'ui-accent' };
}

function isPaidPaymentStatus(paymentStatus) {
	const ps = String(paymentStatus || '').trim().toLowerCase();
	return ps === 'paid' || ps === 'partial_refunded' || ps === 'refunded';
}

function orderStatusLabelTR(order) {
	const o = order && typeof order === 'object' ? order : {};
	const s = String(o.status || '').trim().toLowerCase();
	const ps = String(o.payment_status || '').trim().toLowerCase();
	// Payment-status overrides (avoid conflicting UI like "Sipariş Hazırlanıyor" + "İade Edildi").
	if (ps === 'refunded') return 'İade Edildi';
	if (ps === 'partial_refunded') return 'Kısmi İade';
	if (s === 'cancelled') return orderStageLabelTR(s);
	if (s === 'completed') return orderStageLabelTR(s);
	if (s === 'shipped') return orderStageLabelTR(s);
	// pending
	if (ps === 'failed') return 'Ödeme Başarısız';
	if (ps === 'pending') return 'Ödeme Bekleniyor';
	if (isPaidPaymentStatus(ps)) return orderStageLabelTR(s);
	return 'Sipariş Alındı';
}

module.exports = {
	paymentStatusLabelTR,
	orderStageLabelTR,
	orderStatusLabelTR,
	cancellationRequestTextTR,
	cancellationRequestBadgeTR,
	isPaidPaymentStatus,
};
