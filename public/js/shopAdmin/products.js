(function () {
	var PAGE_SIZE = 25;

	function q(sel, root) {
		return (root || document).querySelector(sel);
	}

	function qa(sel, root) {
		return Array.from((root || document).querySelectorAll(sel));
	}

	function norm(s) {
		return String(s || '')
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.trim();
	}

	function getInt(v) {
		var n = Number(v);
		if (!Number.isFinite(n)) return 0;
		return Math.floor(n);
	}

	function init() {
		var root = q('[data-shopadmin-products-page]');
		if (!root) return;

		var searchEl = q('[data-products-search]', root);
		var lowStockEl = q('[data-products-filter-lowstock]', root);
		var statusEl = q('[data-products-filter-status]', root);
		var countEl = q('[data-products-count]', root);
		var totalEl = q('[data-products-total]', root);
		var listEl = q('#shopAdminProductsList', root);
		var rangeEl = q('[data-products-range]', root);
		var prevBtn = q('[data-products-prev]', root);
		var nextBtn = q('[data-products-next]', root);
		var pagesEl = q('[data-products-pages]', root);
		var paginationWrap = q('[data-products-pagination]', root);

		var cards = listEl ? qa('[data-shopadmin-product-card]', listEl) : [];
		var currentPage = 1;

		function getVisibleIndices() {
			var term = norm(searchEl ? searchEl.value : '');
			var onlyLow = !!(lowStockEl && lowStockEl.checked);
			var status = statusEl ? String(statusEl.value || 'all') : 'all';
			var indices = [];
			for (var i = 0; i < cards.length; i++) {
				var card = cards[i];
				var name = norm(card.getAttribute('data-name'));
				var category = norm(card.getAttribute('data-category'));
				var sizes = norm(card.getAttribute('data-sizes'));
				var colors = norm(card.getAttribute('data-colors'));
				var active = String(card.getAttribute('data-active')) === 'true';
				var stock = getInt(card.getAttribute('data-stock'));
				var threshold = getInt(card.getAttribute('data-threshold'));
				var ok = true;
				if (term) {
					var hay = (name + ' ' + category + ' ' + sizes + ' ' + colors).trim();
					ok = hay.indexOf(term) !== -1;
				}
				if (ok && onlyLow) ok = threshold > 0 && stock <= threshold;
				if (ok && status !== 'all') ok = status === 'active' ? active : !active;
				if (ok) indices.push(i);
			}
			return indices;
		}

		function apply() {
			var indices = getVisibleIndices();
			var total = indices.length;
			var totalAll = cards.length;
			var maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
			if (currentPage > maxPage) currentPage = maxPage;
			var start = (currentPage - 1) * PAGE_SIZE;
			var end = Math.min(start + PAGE_SIZE, total);
			var pageIndices = indices.slice(start, end);
			var visibleSet = new Set(pageIndices);

			for (var i = 0; i < cards.length; i++) {
				cards[i].style.display = visibleSet.has(i) ? '' : 'none';
			}

			if (countEl) countEl.textContent = String(total);
			if (totalEl) totalEl.textContent = String(totalAll);

			if (paginationWrap) {
				paginationWrap.style.display = totalAll === 0 ? 'none' : 'flex';
			}
			if (rangeEl) {
				if (total === 0) {
					rangeEl.textContent = '0 / ' + totalAll;
				} else {
					rangeEl.textContent = (start + 1) + '–' + end + ' / ' + total;
				}
			}
			if (pagesEl) pagesEl.textContent = 'Sayfa ' + currentPage + ' / ' + maxPage;
			if (prevBtn) {
				prevBtn.disabled = currentPage <= 1;
			}
			if (nextBtn) {
				nextBtn.disabled = currentPage >= maxPage || maxPage <= 1;
			}
		}

		if (searchEl) searchEl.addEventListener('input', function () { currentPage = 1; apply(); });
		if (lowStockEl) lowStockEl.addEventListener('change', function () { currentPage = 1; apply(); });
		if (statusEl) statusEl.addEventListener('change', function () { currentPage = 1; apply(); });

		if (prevBtn) {
			prevBtn.addEventListener('click', function () {
				if (currentPage > 1) { currentPage--; apply(); }
			});
		}
		if (nextBtn) {
			nextBtn.addEventListener('click', function () {
				var indices = getVisibleIndices();
				var maxPage = Math.max(1, Math.ceil(indices.length / PAGE_SIZE));
				if (currentPage < maxPage) { currentPage++; apply(); }
			});
		}

		apply();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
