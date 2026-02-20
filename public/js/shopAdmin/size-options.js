document.addEventListener('DOMContentLoaded', () => {
	function splitExisting(raw) {
		if (raw == null) return [];
		const s = String(raw).trim();
		if (!s) return [];
		return s
			.split(/[\n,;]+/)
			.map((x) => String(x || '').trim())
			.filter(Boolean);
	}

	function normalizeUnit(raw) {
		const u = String(raw || '').trim().toLowerCase();
		if (u === 'ml') return 'ml';
		if (u === 'gr' || u === 'g') return 'gr';
		return 'ml';
	}

	function normalizeSizeLabel(valueRaw, unitRaw) {
		const unit = normalizeUnit(unitRaw);
		const n = Number(String(valueRaw || '').replace(',', '.'));
		if (!Number.isFinite(n) || n <= 0) return null;
		// Keep integers clean, allow decimals if needed.
		const label = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
		return `${label} ${unit}`;
	}

	function initOne(root) {
		const sizeTextarea = root.querySelector('[data-size-options]');
		const valueEl = root.querySelector('[data-size-value]');
		const unitEl = root.querySelector('[data-size-unit]');
		const addBtn = root.querySelector('[data-size-add]');
		const helpEl = root.querySelector('[data-size-help]');
		if (!sizeTextarea || !valueEl || !unitEl || !addBtn) return;

		const syncHelp = () => {
			if (!helpEl) return;
			const list = splitExisting(sizeTextarea.value);
			helpEl.textContent = list.length
				? `Mevcut: ${list.join(' / ')}`
				: 'Henüz boyut eklenmedi.';
		};

		addBtn.addEventListener('click', (e) => {
			e.preventDefault();
			const label = normalizeSizeLabel(valueEl.value, unitEl.value);
			if (!label) {
				valueEl.focus();
				return;
			}
			const current = splitExisting(sizeTextarea.value);
			if (!current.includes(label)) current.push(label);
			sizeTextarea.value = current.join(', ');
			valueEl.value = '';
			syncHelp();
			// Trigger variant table update (admin/product-variant-stock.js listens on input)
			sizeTextarea.dispatchEvent(new Event('input', { bubbles: true }));
		});

		sizeTextarea.addEventListener('input', syncHelp);
		syncHelp();
	}

	const roots = document.querySelectorAll('[data-variant-stock-editor]');
	for (const r of roots) initOne(r);
});
