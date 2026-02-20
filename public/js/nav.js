(function () {
	function qs(root, sel) {
		return root.querySelector(sel);
	}

	function qsa(root, sel) {
		return Array.from(root.querySelectorAll(sel));
	}

	function setOpen(toggle, panel, open) {
		var isOpen = Boolean(open);
		toggle.setAttribute('aria-expanded', String(isOpen));
		panel.setAttribute('data-open', String(isOpen));
	}

	function bindOne(toggle, panel) {
		if (!toggle || !panel) return;

		var isOpen = toggle.getAttribute('aria-expanded') === 'true';
		setOpen(toggle, panel, isOpen);

		toggle.addEventListener('click', function () {
			var next = toggle.getAttribute('aria-expanded') !== 'true';
			setOpen(toggle, panel, next);
		});

		qsa(panel, 'a, button[type="submit"], [data-mobile-nav-close]').forEach(function (el) {
			el.addEventListener('click', function () {
				setOpen(toggle, panel, false);
			});
		});

		window.addEventListener('keydown', function (e) {
			if (e && e.key === 'Escape') {
				setOpen(toggle, panel, false);
			}
		});

		window.addEventListener('resize', function () {
			// If user resizes up to desktop (lg: 1024px), ensure mobile panel is closed.
			if (window.innerWidth >= 1024) {
				setOpen(toggle, panel, false);
			}
		});
	}

	function bindAll() {
		qsa(document, '[data-mobile-nav-root]').forEach(function (root) {
			bindOne(
				qs(root, '[data-mobile-nav-toggle]'),
				qs(root, '[data-mobile-nav-panel]')
			);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindAll);
	} else {
		bindAll();
	}
})();
