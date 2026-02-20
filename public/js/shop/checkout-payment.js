(function () {
	try {
		var input = document.getElementById('checkoutPayMode');
		if (!input) return;

		var isMobile = false;
		if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
			isMobile = navigator.userAgentData.mobile;
		} else {
			var ua = String(navigator.userAgent || '').toLowerCase();
			isMobile = /iphone|ipad|ipod|android|mobile|windows phone|webos|blackberry|opera mini|iemobile/.test(ua);
		}

		if (!isMobile) {
			try {
				isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
			} catch (e) {
				// ignore
			}
		}

		if (isMobile) {
			// Mobile browsers/apps often fail to render the embedded checkout form.
			// Use provider-hosted payment page redirect instead.
			input.value = 'redirect';
		}

		var poller = document.getElementById('order-status-poller');
		if (poller) {
			var orderId = poller.dataset ? (poller.dataset.orderId || '') : '';
			var successUrl = poller.dataset ? (poller.dataset.successUrl || '') : '';
			if (orderId) {
				var startedAt = Date.now();
				var maxMs = 3 * 60 * 1000;
				var timer = window.setInterval(function () {
					try {
						if (Date.now() - startedAt > maxMs) {
							window.clearInterval(timer);
							return;
						}
						fetch('/order-status?orderId=' + encodeURIComponent(orderId), {
							credentials: 'same-origin',
							headers: { 'accept': 'application/json' }
						})
							.then(function (r) { return r.ok ? r.json() : null; })
							.then(function (data) {
								if (!data || !data.ok) return;
								var status = String(data.status || '').toLowerCase();
								if (status === 'paid') {
									var target = data.successUrl || successUrl || ('/order-success?orderId=' + encodeURIComponent(orderId));
									try {
										if (window.top && window.top !== window) {
											window.top.location.href = target;
											return;
										}
									} catch (e) {
										// ignore
									}
									window.location.href = target;
								}
							})
							.catch(function () { /* ignore */ });
					} catch (e) {
						// ignore
					}
				}, 3000);
			}
		}

	} catch (e) {
		// ignore
	}
})();
