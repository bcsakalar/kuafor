(function () {
	function splitOptionList(raw) {
		if (raw == null) return [];
		const s = String(raw).trim();
		if (!s) return [];
		const parts = s
			.split(/[\n,;]+/)
			.map((x) => String(x || '').trim())
			.filter(Boolean);
		// unique, keep order
		const seen = new Set();
		const out = [];
		for (const p of parts) {
			if (seen.has(p)) continue;
			seen.add(p);
			out.push(p);
		}
		return out;
	}

	function buildVariantKey(selectedSize, selectedColor) {
		const s = selectedSize == null ? '' : String(selectedSize);
		const c = selectedColor == null ? '' : String(selectedColor);
		return JSON.stringify([s, c]);
	}

	function safeInt(value) {
		const n = Number(value);
		if (!Number.isFinite(n)) return 0;
		return Math.max(0, Math.floor(n));
	}

	function safeMoneyOrNull(value) {
		if (value == null) return null;
		const s = String(value).trim();
		if (!s) return null;
		const n = Number(s);
		if (!Number.isFinite(n) || n < 0) return null;
		// Keep as a Number; server stores numeric(12,2)
		return Math.round(n * 100) / 100;
	}

	function initOne(root) {
		const sizeEl = root.querySelector('[data-size-options]');
		const colorEl = root.querySelector('[data-color-options]');
		const shareEl = root.querySelector('[data-share-colors-stock]');
		const sharePriceEl = root.querySelector('[data-share-colors-price]');
		const stockEl = root.querySelector('[data-product-stock]');
		const hiddenEl = root.querySelector('[data-variant-stocks-json]');
		const tableEl = root.querySelector('[data-variant-stocks-table]');
		const tbodyEl = root.querySelector('[data-variant-stocks-tbody]');
		const totalEl = root.querySelector('[data-variant-total]');
		const hintEl = root.querySelector('[data-variant-hint]');

		if (!sizeEl || !colorEl || !hiddenEl || !tableEl || !tbodyEl) return;

		let initial = [];
		try {
			initial = JSON.parse(hiddenEl.value || '[]');
			if (!Array.isArray(initial)) initial = [];
		} catch {
			initial = [];
		}

		// Map by variantKey -> stock
		const byKey = new Map();
		for (const it of initial) {
			const k = it && typeof it === 'object' ? it.variantKey : null;
			if (!k) continue;
			byKey.set(String(k), {
				stock: safeInt(it.stock),
				price: safeMoneyOrNull(it.price),
			});
		}

		function normalizeSharedStocks({ sizes, colors } = {}) {
			if (!shareEl || !shareEl.checked) return;
			const effectiveSizes = Array.isArray(sizes) && sizes.length ? sizes : splitOptionList(sizeEl.value);
			const effectiveColors = Array.isArray(colors) && colors.length ? colors : splitOptionList(colorEl.value);
			const useSizes = effectiveSizes.length ? effectiveSizes : [''];
			const useColors = effectiveColors.length ? effectiveColors : [''];
			for (const s of useSizes) {
				if (!s) continue;
				let maxStock = 0;
				for (const c of useColors) {
					const key = buildVariantKey(s, c);
					const current = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					maxStock = Math.max(maxStock, safeInt(current.stock));
				}
				for (const c of useColors) {
					const key = buildVariantKey(s, c);
					const prev = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					byKey.set(key, { stock: maxStock, price: safeMoneyOrNull(prev.price) });
				}
			}
		}

		function normalizeSharedPrices({ sizes, colors } = {}) {
			if (!sharePriceEl || !sharePriceEl.checked) return;
			const effectiveSizes = Array.isArray(sizes) && sizes.length ? sizes : splitOptionList(sizeEl.value);
			const effectiveColors = Array.isArray(colors) && colors.length ? colors : splitOptionList(colorEl.value);
			const useSizes = effectiveSizes.length ? effectiveSizes : [''];
			const useColors = effectiveColors.length ? effectiveColors : [''];
			for (const s of useSizes) {
				if (!s) continue;
				let chosen = null;
				for (const c of useColors) {
					const key = buildVariantKey(s, c);
					const current = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					const p = safeMoneyOrNull(current.price);
					if (p != null) {
						chosen = p;
						break;
					}
				}
				for (const c of useColors) {
					const key = buildVariantKey(s, c);
					const prev = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					byKey.set(key, { stock: safeInt(prev.stock), price: chosen });
				}
			}
		}

		function render() {
			const sizes = splitOptionList(sizeEl.value);
			const colors = splitOptionList(colorEl.value);
			const shareAcrossColors = !!(shareEl && shareEl.checked);
			const sharePriceAcrossColors = !!(sharePriceEl && sharePriceEl.checked);

			const useVariants = sizes.length > 0 || colors.length > 0;
			tableEl.style.display = useVariants ? '' : 'none';
			if (hintEl) hintEl.style.display = useVariants ? '' : 'none';

			if (stockEl) {
				// If variants exist, stock is derived from variant totals.
				stockEl.readOnly = useVariants;
				stockEl.style.opacity = useVariants ? '0.75' : '';
			}

			// Clear existing
			tbodyEl.innerHTML = '';

			if (!useVariants) {
				hiddenEl.value = '[]';
				if (totalEl) totalEl.textContent = '';
				return;
			}

			const effectiveSizes = sizes.length ? sizes : [''];
			const effectiveColors = colors.length ? colors : [''];

			if (shareAcrossColors) {
				normalizeSharedStocks({ sizes: effectiveSizes, colors: effectiveColors });
			}
			if (sharePriceAcrossColors) {
				normalizeSharedPrices({ sizes: effectiveSizes, colors: effectiveColors });
			}

			let total = 0;
			const perSizeTotal = new Map();
			const out = [];

			for (const s of effectiveSizes) {
				for (const c of effectiveColors) {
					const key = buildVariantKey(s, c);
					const current = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					const currentStock = safeInt(current.stock);
					const currentPrice = safeMoneyOrNull(current.price);
					const row = document.createElement('tr');
					row.className = 'border-b border-[color:var(--border)]';

					const tdSize = document.createElement('td');
					tdSize.className = 'py-2 pr-3 text-sm ui-muted';
					tdSize.textContent = s || '-';

					const tdColor = document.createElement('td');
					tdColor.className = 'py-2 pr-3 text-sm ui-muted';
					tdColor.textContent = c || '-';

					const tdStock = document.createElement('td');
					tdStock.className = 'py-2';
					const input = document.createElement('input');
					input.type = 'number';
					input.min = '0';
					input.step = '1';
					input.value = String(currentStock);
					input.className = 'border ui-border bg-[color:var(--bg-elevated)] rounded px-3 py-2 text-sm w-32';
					input.setAttribute('data-variant-key', key);
					input.setAttribute('data-field', 'stock');
					input.setAttribute('data-selected-size', String(s || ''));
					input.setAttribute('data-selected-color', String(c || ''));
					input.addEventListener('input', () => {
						const next = safeInt(input.value);
						const prev = byKey.get(key) || { stock: 0, price: null };
						if (shareEl && shareEl.checked && s) {
							for (const cc of effectiveColors) {
								const kk = buildVariantKey(s, cc);
								const pp = byKey.get(kk) || { stock: 0, price: null };
								byKey.set(kk, { stock: next, price: safeMoneyOrNull(pp.price) });
							}
							// Keep UI in sync without re-rendering (avoid focus loss).
							for (const el of tbodyEl.querySelectorAll('input[data-field="stock"]')) {
								if (el === input) continue;
								if (String(el.getAttribute('data-selected-size') || '') !== String(s || '')) continue;
								el.value = String(next);
							}
						} else {
							byKey.set(key, { stock: next, price: safeMoneyOrNull(prev.price) });
						}
						syncHidden();
					});
					tdStock.appendChild(input);

					const tdPrice = document.createElement('td');
					tdPrice.className = 'py-2';
					const priceInput = document.createElement('input');
					priceInput.type = 'number';
					priceInput.min = '0';
					priceInput.step = '0.01';
					priceInput.required = true;
					priceInput.placeholder = '—';
					priceInput.value = currentPrice == null ? '' : String(currentPrice);
					priceInput.className = 'border ui-border bg-[color:var(--bg-elevated)] rounded px-3 py-2 text-sm w-32';
					priceInput.setAttribute('data-variant-key', key);
					priceInput.setAttribute('data-field', 'price');
					priceInput.setAttribute('data-selected-size', String(s || ''));
					priceInput.setAttribute('data-selected-color', String(c || ''));
					priceInput.addEventListener('input', () => {
						const nextPrice = safeMoneyOrNull(priceInput.value);
						const prev = byKey.get(key) || { stock: 0, price: null };
						if (sharePriceEl && sharePriceEl.checked && s) {
							for (const cc of effectiveColors) {
								const kk = buildVariantKey(s, cc);
								const pp = byKey.get(kk) || { stock: 0, price: null };
								byKey.set(kk, { stock: safeInt(pp.stock), price: nextPrice });
							}
							// Keep UI in sync without re-rendering (avoid focus loss).
							for (const el of tbodyEl.querySelectorAll('input[data-field="price"]')) {
								if (el === priceInput) continue;
								if (String(el.getAttribute('data-selected-size') || '') !== String(s || '')) continue;
								el.value = nextPrice == null ? '' : String(nextPrice);
							}
						} else {
							byKey.set(key, { stock: safeInt(prev.stock), price: nextPrice });
						}
						syncHidden();
					});
					tdPrice.appendChild(priceInput);

					row.appendChild(tdSize);
					row.appendChild(tdColor);
					row.appendChild(tdStock);
					row.appendChild(tdPrice);
					tbodyEl.appendChild(row);

					if (shareAcrossColors && s) {
						const prev = perSizeTotal.get(s) ?? 0;
						perSizeTotal.set(s, Math.max(prev, safeInt(currentStock)));
					} else {
						total += safeInt(currentStock);
					}
					out.push({
						variantKey: key,
						selectedSize: s || '',
						selectedColor: c || '',
						stock: safeInt(currentStock),
						price: currentPrice,
					});
				}
			}
			if (shareAcrossColors) {
				for (const v of perSizeTotal.values()) total += v;
			}

			// clean byKey to only current combinations
			const activeKeys = new Set(out.map((x) => x.variantKey));
			for (const k of Array.from(byKey.keys())) {
				if (!activeKeys.has(k)) byKey.delete(k);
			}

			hiddenEl.value = JSON.stringify(out);
			if (stockEl) stockEl.value = String(total);
			if (totalEl) totalEl.textContent = String(total);
		}

		function syncHidden() {
			// Update hidden payload + totals without rebuilding the table.
			const sizes = splitOptionList(sizeEl.value);
			const colors = splitOptionList(colorEl.value);
			const shareAcrossColors = !!(shareEl && shareEl.checked);
			const useVariants = sizes.length > 0 || colors.length > 0;
			if (!useVariants) {
				hiddenEl.value = '[]';
				if (stockEl) stockEl.value = '0';
				if (totalEl) totalEl.textContent = '';
				return;
			}

			const effectiveSizes = sizes.length ? sizes : [''];
			const effectiveColors = colors.length ? colors : [''];
			let total = 0;
			const perSizeTotal = new Map();
			const out = [];

			for (const s of effectiveSizes) {
				for (const c of effectiveColors) {
					const key = buildVariantKey(s, c);
					const current = byKey.has(key) ? byKey.get(key) : { stock: 0, price: null };
					const currentStock = safeInt(current.stock);
					const currentPrice = safeMoneyOrNull(current.price);

					if (shareAcrossColors && s) {
						const prev = perSizeTotal.get(s) ?? 0;
						perSizeTotal.set(s, Math.max(prev, currentStock));
					} else {
						total += currentStock;
					}

					out.push({
						variantKey: key,
						selectedSize: s || '',
						selectedColor: c || '',
						stock: currentStock,
						price: currentPrice,
					});
				}
			}
			if (shareAcrossColors) {
				for (const v of perSizeTotal.values()) total += v;
			}

			// Keep byKey only for active combinations.
			const activeKeys = new Set(out.map((x) => x.variantKey));
			for (const k of Array.from(byKey.keys())) {
				if (!activeKeys.has(k)) byKey.delete(k);
			}

			hiddenEl.value = JSON.stringify(out);
			if (stockEl) stockEl.value = String(total);
			if (totalEl) totalEl.textContent = String(total);
		}

		sizeEl.addEventListener('input', () => {
			// Debounce-ish: small delay so typing doesn't flicker too much.
			clearTimeout(sizeEl.__variantTimer);
			sizeEl.__variantTimer = setTimeout(render, 150);
		});
		colorEl.addEventListener('input', () => {
			clearTimeout(colorEl.__variantTimer);
			colorEl.__variantTimer = setTimeout(render, 150);
		});
		if (shareEl) {
			shareEl.addEventListener('change', () => {
				render();
			});
		}
		if (sharePriceEl) {
			sharePriceEl.addEventListener('change', () => {
				render();
			});
		}

		render();
	}

	document.addEventListener('DOMContentLoaded', () => {
		const roots = document.querySelectorAll('[data-variant-stock-editor]');
		for (const r of roots) initOne(r);
	});
})();
