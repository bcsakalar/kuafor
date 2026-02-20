(function () {
	function normalizeTrackingCodeInput(value) {
		var raw = String(value || '').trim();
		if (!raw) return '';
		// If user pasted UUID, keep it.
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
			return raw;
		}
		var upper = raw.toUpperCase();
		var compact = upper.replace(/[^A-Z0-9]/g, '');
		if (compact.startsWith('TRK')) compact = compact.slice(3);
		if (compact.length !== 12) return upper;
		return 'TRK-' + compact.slice(0, 4) + '-' + compact.slice(4, 8) + '-' + compact.slice(8, 12);
	}

	function copyText(text) {
		if (!text) return Promise.reject(new Error('empty'));
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text);
		}
		// Fallback
		var ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand('copy');
			return Promise.resolve();
		} finally {
			document.body.removeChild(ta);
		}
	}

	function attach() {
		var input = document.querySelector('[data-track-input]');
		if (input) {
			input.addEventListener('blur', function () {
				input.value = normalizeTrackingCodeInput(input.value);
			});
			input.addEventListener('paste', function () {
				setTimeout(function () {
					input.value = normalizeTrackingCodeInput(input.value);
				}, 0);
			});
		}

		var buttons = document.querySelectorAll('[data-copy-value]');
		buttons.forEach(function (btn) {
			btn.addEventListener('click', function (e) {
				e.preventDefault();
				var value = btn.getAttribute('data-copy-value') || '';
				copyText(value)
					.then(function () {
						var original = btn.textContent;
						btn.textContent = 'Kopyalandı';
						setTimeout(function () { btn.textContent = original; }, 1200);
					})
					.catch(function () {
						// ignore
					});
			});
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', attach);
	} else {
		attach();
	}
})();
