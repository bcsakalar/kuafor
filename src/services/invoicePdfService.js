/**
 * E-fatura / satış fişi PDF üretimi. Sipariş onay e-postasına eklenir.
 * Türkçe karakter desteği için Roboto fontu kullanılır.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const { logger } = require('../config/logger');

// Türkçe karakter destekli font (Helvetica ğ, ü, ş, ö, ç, ı, İ, ₺ desteklemiyor)
const ROBOTO_REGULAR = path.join(__dirname, '../../node_modules/roboto-regular/fonts/Roboto-Regular.ttf');

function moneyTR(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return '0,00 ₺';
	return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

function formatDateTR(date) {
	if (!date) return '—';
	const d = date instanceof Date ? date : new Date(date);
	return d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Metni belirtilen genişlikte keser, taşmayı önler.
 */
function truncateText(text, maxLength = 50) {
	const s = String(text || '').trim();
	if (s.length <= maxLength) return s;
	return s.slice(0, maxLength - 2) + '…';
}

/**
 * Adres vb. uzun metinleri satır genişliğine göre böler (sadece uzunluk kontrolü).
 */
function wrapAddress(addr, maxChars = 60) {
	const s = String(addr || '').trim();
	if (!s) return [];
	const lines = [];
	let rest = s;
	while (rest.length > maxChars) {
		const chunk = rest.slice(0, maxChars);
		const lastSpace = chunk.lastIndexOf(' ');
		const cut = lastSpace > maxChars / 2 ? lastSpace : maxChars;
		lines.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) lines.push(rest);
	return lines;
}

/**
 * Sipariş ve şirket ayarlarıyla e-fatura tarzı PDF üretir.
 * @param {Object} order - getOrderWithItems çıktısı (id, tracking_code, created_at, total_amount, customer_*, shipping_address, items)
 * @param {Object} company - getCompanySettings çıktısı (company_name, tax_office, tax_number, contact_address, contact_email, kep_address)
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateInvoicePdf(order, company = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const doc = new PDFDocument({ margin: 50, size: 'A4' });
		const pageWidth = 595;
		const pageHeight = 842;
		const margin = 50;
		const contentWidth = pageWidth - margin * 2;

		doc.on('data', (chunk) => chunks.push(chunk));
		doc.on('end', () => resolve(Buffer.concat(chunks)));
		doc.on('error', reject);

		// Türkçe destekli font kaydı
		try {
			doc.registerFont('Roboto', ROBOTO_REGULAR);
			doc.font('Roboto');
		} catch (fontErr) {
			logger.warn('[invoicePdf] Roboto font yüklenemedi, Helvetica kullanılıyor', { message: fontErr?.message });
		}

		const trackingCode = String(order.tracking_code || order.id || '').trim().toUpperCase();
		const invoiceNo = trackingCode || `SIP-${String(order.id || '').slice(0, 8)}`;
		const invoiceTitle = 'E-FATURA / SATIŞ FİŞİ';

		// Başlık
		doc.fontSize(18).font('Roboto').text(invoiceTitle, margin, 50, { align: 'center', width: contentWidth });
		doc.moveDown(0.5);
		doc.fontSize(10).text(`Fatura No: ${invoiceNo}`, { align: 'center' });
		doc.text(`Tarih: ${formatDateTR(order.created_at)}`, { align: 'center' });
		doc.moveDown(1.5);

		// Satıcı (şirket)
		doc.fontSize(11).text('SATICI', { continued: false });
		doc.fontSize(10);
		const hasCompany = company.company_name || company.contact_address || company.tax_office || company.tax_number || company.contact_email || company.kep_address;
		if (hasCompany) {
			doc.text(company.company_name || '—', { continued: false, width: contentWidth });
			if (company.contact_address) {
				wrapAddress(company.contact_address, 55).forEach((line) => doc.text(line, { continued: false, width: contentWidth }));
			}
			if (company.tax_office || company.tax_number) {
				doc.text(`Vergi Dairesi: ${company.tax_office || '—'} / Vergi No: ${company.tax_number || '—'}`, { continued: false, width: contentWidth });
			}
			if (company.contact_email) doc.text(`E-posta: ${company.contact_email}`, { continued: false, width: contentWidth });
			if (company.kep_address) doc.text(`KEP: ${company.kep_address}`, { continued: false, width: contentWidth });
		} else {
			doc.text('Lütfen admin panelinden Şirket Ayarları bölümünü doldurun.', { continued: false, width: contentWidth });
		}
		doc.moveDown(1);

		// Alıcı (müşteri)
		doc.fontSize(11).text('ALICI', { continued: false });
		doc.fontSize(10);
		doc.text(order.customer_full_name || 'Müşteri', { continued: false, width: contentWidth });
		if (order.shipping_address) {
			wrapAddress(order.shipping_address, 55).forEach((line) => doc.text(line, { continued: false, width: contentWidth }));
		}
		if (order.customer_phone) doc.text(`Telefon: ${order.customer_phone}`, { continued: false, width: contentWidth });
		if (order.customer_email) doc.text(`E-posta: ${order.customer_email}`, { continued: false, width: contentWidth });
		doc.moveDown(1.5);

		// Kalemler tablosu - sütunlar sayfa içinde kalacak şekilde ayarlandı
		const items = Array.isArray(order.items) ? order.items : [];
		const tableTop = doc.y;
		const col1 = 50;        // Ürün başlangıç
		const col1Width = 200;  // Ürün max genişlik
		const col2 = 255;       // Miktar
		const col3 = 295;       // Birim Fiyat
		const col4 = 385;       // Tutar (sağa hizalı)
		const col4Width = 100;  // Tutar sütun genişliği
		const tableRight = margin + contentWidth;

		doc.fontSize(9);
		doc.text('Ürün', col1, tableTop, { width: col1Width });
		doc.text('Miktar', col2, tableTop, { width: 35 });
		doc.text('Birim Fiyat', col3, tableTop, { width: 85 });
		doc.text('Tutar', col4, tableTop, { width: col4Width, align: 'right' });
		doc.moveTo(margin, tableTop + 14).lineTo(tableRight, tableTop + 14).stroke();
		doc.moveDown(0.3);

		let y = tableTop + 20;
		doc.fontSize(9);

		for (const it of items) {
			const name = String(it.product_name || it.productName || 'Ürün').trim();
			const qty = Number(it.quantity) || 0;
			const unitPrice = Number(it.price_at_purchase) != null ? Number(it.price_at_purchase) : Number(it.unitPrice) || 0;
			const lineTotal = qty * unitPrice;
			const variant = [it.selected_size || it.selectedSize, it.selected_color || it.selectedColor].filter(Boolean).join(' / ');
			const nameLine = truncateText(variant ? `${name} (${variant})` : name, 38);

			if (y > 700) {
				doc.addPage();
				y = 50;
			}
			doc.text(nameLine, col1, y, { width: col1Width });
			doc.text(String(qty), col2, y, { width: 35 });
			doc.text(moneyTR(unitPrice), col3, y, { width: 85 });
			doc.text(moneyTR(lineTotal), col4, y, { width: col4Width, align: 'right' });
			y += 22;
		}

		doc.moveTo(margin, y + 5).lineTo(tableRight, y + 5).stroke();
		y += 18;
		doc.text('GENEL TOPLAM:', col3, y);
		doc.text(moneyTR(order.total_amount), col4, y, { width: col4Width, align: 'right' });

		// Uyarı metni: 1. sayfada, fatura bilgilerinin hemen altında (2. sayfaya taşınmasın)
		y += 28;
		doc.fontSize(8).fillColor('#666666');
		const footerText = 'Bu belge elektronik satış fişi / e-fatura niteliğindedir. Sipariş takip kodu: ' + (trackingCode || order.id || '—');
		doc.text(footerText, margin, y, { align: 'center', width: contentWidth });
		doc.fillColor('#000000');
		doc.end();
	});
}

/**
 * Sipariş için e-fatura PDF buffer üretir; şirket bilgisi yoksa sadece sipariş bilgileriyle üretir.
 * Hata durumunda null döner (e-posta ekisiz devam edilir).
 */
async function generateInvoicePdfForOrder(order, companySettings) {
	try {
		const company = companySettings && typeof companySettings === 'object' ? companySettings : {};
		return await generateInvoicePdf(order, company);
	} catch (err) {
		logger.warn('[invoicePdf] generate failed', {
			orderId: order?.id,
			message: err?.message,
			code: err?.code,
		});
		return null;
	}
}

module.exports = {
	generateInvoicePdf,
	generateInvoicePdfForOrder,
};
