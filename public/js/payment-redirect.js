(function () {
	try {
		var s = document.currentScript;
		var url = s && s.dataset ? (s.dataset.redirectUrl || s.dataset.successUrl || '') : '';
		if (!url) return;

		var nav = function (w, targetUrl) {
			try {
				// Prefer replace to avoid users going back into the provider frame.
				w.location.replace(targetUrl);
				return true;
			} catch (e1) {
				try {
					w.location.href = targetUrl;
					return true;
				} catch (e2) {
					return false;
				}
			}
		};

		var isOrderSuccess = /(^|\/|\.)order-success\b/i.test(url) || /\/order-success\b/i.test(url);

		// If this page is rendered inside an iframe, try to jump the top window.
		// If that is blocked (sandbox / browser policy), keep the helper visible.
		// NOTE: /order-success cannot be embedded due to global CSP frame-ancestors 'none'.
		if (window.top && window.top !== window) {
			if (nav(window.top, url)) return;
			if (isOrderSuccess) return;
		}
		nav(window, url);
	} catch (e) {
		// ignore
	}
})();
