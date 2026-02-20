document.addEventListener('DOMContentLoaded', () => {
	function buildVariantKey(selectedSize, selectedColor) {
		const s = selectedSize == null ? '' : String(selectedSize);
		const c = selectedColor == null ? '' : String(selectedColor);
		return JSON.stringify([s, c]);
	}

	function parseJsonSafe(raw, fallback) {
		try {
			const parsed = JSON.parse(String(raw || ''));
			return parsed && typeof parsed === 'object' ? parsed : fallback;
		} catch {
			return fallback;
		}
	}

	function formatTL(n) {
		const v = Number(n);
		if (!Number.isFinite(v)) return null;
		const hasFraction = Math.abs(v % 1) > 1e-9;
		const formatted = v.toLocaleString('tr-TR', {
			minimumFractionDigits: hasFraction ? 2 : 0,
			maximumFractionDigits: 2,
		});
		return `${formatted} ₺`;
	}

	const forms = Array.from(document.querySelectorAll('form[action="/cart/add"]'));
	for (const form of forms) {
		const sizeSelect = form.querySelector('select[name="selected_size"]');
		const colorSelect = form.querySelector('select[name="selected_color"]');
		const sizeField = sizeSelect || form.querySelector('input[type="hidden"][name="selected_size"]');
		const colorField = colorSelect || form.querySelector('input[type="hidden"][name="selected_color"]');
		if (!sizeField && !colorField) continue;

		// Optional: variant pricing hints
		const basePriceEl = form.querySelector('[data-base-price]');
		const variantPricesEl = form.querySelector('[data-variant-prices-json]');
		const basePriceNum = basePriceEl ? Number(basePriceEl.value) : NaN;
		const variantPrices = variantPricesEl ? parseJsonSafe(variantPricesEl.value, {}) : {};
		const priceDisplayEl = form.closest('.ui-card')
			? form.closest('.ui-card').querySelector('[data-price-display]')
			: document.querySelector('[data-price-display]');

		function updatePrice() {
			if (!priceDisplayEl) return;
			const s = sizeField ? String(sizeField.value || '').trim() : '';
			const c = colorField ? String(colorField.value || '').trim() : '';
			const key = buildVariantKey(s, c);
			const overrideRaw = variantPrices && typeof variantPrices === 'object' ? variantPrices[key] : undefined;
			const overrideNum = overrideRaw === undefined || overrideRaw === null ? NaN : Number(overrideRaw);
			const unit = Number.isFinite(overrideNum) && overrideNum >= 0
				? overrideNum
				: basePriceNum;
			const label = formatTL(unit);
			if (label) priceDisplayEl.textContent = label;
		}

		if (sizeSelect) sizeSelect.addEventListener('change', updatePrice);
		if (colorSelect) colorSelect.addEventListener('change', updatePrice);
		updatePrice();

		form.addEventListener('submit', (e) => {
			const missing = [];
			if (sizeSelect && sizeSelect.required && !String(sizeSelect.value || '').trim()) missing.push('boyut');
			if (colorSelect && colorSelect.required && !String(colorSelect.value || '').trim()) missing.push('renk');
			if (missing.length === 0) return;

			e.preventDefault();

			const box = form.querySelector('[data-variant-error]');
			if (box) {
				box.classList.remove('hidden');
				box.textContent = missing.length === 2
					? 'Lütfen boyut (ml/gr) ve renk seçin.'
					: (missing[0] === 'boyut' ? 'Lütfen boyut (ml/gr) seçin.' : 'Lütfen renk seçin.');
			}

			const firstMissingEl = (missing.includes('boyut') ? sizeSelect : null) || (missing.includes('renk') ? colorSelect : null);
			if (firstMissingEl && typeof firstMissingEl.focus === 'function') firstMissingEl.focus();
		});

		const box = form.querySelector('[data-variant-error]');
		const hide = () => { if (box) box.classList.add('hidden'); };
		if (sizeSelect) sizeSelect.addEventListener('change', hide);
		if (colorSelect) colorSelect.addEventListener('change', hide);
	}
});
