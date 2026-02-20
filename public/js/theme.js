// Dual identity toggle (men/women) with localStorage persistence.
(function () {
	function isGalleryPage() {
		try {
			return window.location && window.location.pathname === '/galeri';
		} catch {
			return false;
		}
	}

	function getUrlCategory() {
		try {
			var params = new URLSearchParams(window.location.search || '');
			var c = String(params.get('category') || '').toLowerCase();
			return c === 'women' ? 'women' : (c === 'men' ? 'men' : '');
		} catch {
			return '';
		}
	}

	function navigateGalleryToCategory(category) {
		try {
			var params = new URLSearchParams(window.location.search || '');
			params.set('category', category);
			params.set('page', '1');
			window.location.assign(window.location.pathname + '?' + params.toString());
		} catch {
			// no-op
		}
	}

	function getCategory() {
		var current = document.documentElement.getAttribute('data-category');
		return current === 'women' ? 'women' : 'men';
	}

	function setCategory(next) {
		var category = next === 'women' ? 'women' : 'men';
		document.documentElement.setAttribute('data-category', category);
		try {
			localStorage.setItem('category', category);
		} catch {
			// no-op
		}
		document.dispatchEvent(new CustomEvent('category:changed', { detail: { category } }));
		updateToggles();
		if (isGalleryPage()) {
			navigateGalleryToCategory(category);
		}
	}

	function updateToggles() {
		var category = getCategory();
		var toggles = Array.from(document.querySelectorAll('[data-category-toggle]'));
		toggles.forEach(function (el) {
			el.setAttribute('aria-pressed', String(category === 'women'));
			el.setAttribute('data-active', category);
		});
		var labels = Array.from(document.querySelectorAll('[data-category-label]'));
		labels.forEach(function (el) {
			el.textContent = category === 'men' ? 'KUAFÖR' : 'GÜZELLİK';
		});
	}

	function bind() {
		// Keep /galeri server-rendered content aligned with the chosen category.
		if (isGalleryPage()) {
			var urlCategory = getUrlCategory();
			if (urlCategory === 'men' || urlCategory === 'women') {
				// Respect explicit URL and persist it.
				if (getCategory() !== urlCategory) {
					setCategory(urlCategory);
				}
			} else {
				// URL has no category; redirect so server can filter/paginate correctly.
				navigateGalleryToCategory(getCategory());
				return;
			}
		}

		updateToggles();
		Array.from(document.querySelectorAll('[data-category-toggle]')).forEach(function (el) {
			el.addEventListener('click', function () {
				setCategory(getCategory() === 'men' ? 'women' : 'men');
			});
		});
		Array.from(document.querySelectorAll('[data-category-set]')).forEach(function (el) {
			el.addEventListener('click', function () {
				var next = el.getAttribute('data-category-set');
				setCategory(next);
			});
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bind);
	} else {
		bind();
	}
})();
