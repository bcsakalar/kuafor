// Universal realtime client (Socket.IO)
// - Creates a single shared socket connection
// - Provides lightweight toasts/banners
// - Optionally subscribes to order/tracking rooms via data attributes
(() => {
	if (typeof window.io !== 'function') return;

	// Shared TR label helpers (client-side).
	// Keep these consistent with src/utils/statusLabels.js.
	if (!window.__STATUS_LABELS_TR__) {
		window.__STATUS_LABELS_TR__ = {
			orderStageLabelTR: (status) => {
				const s = String(status || '').trim().toLowerCase();
				if (s === 'cancelled') return 'İptal Edildi';
				if (s === 'completed') return 'Teslim Edildi';
				if (s === 'shipped') return 'Kargoya Verildi';
				if (s === 'pending') return 'Sipariş Alındı';
				return String(status || '').trim() || '—';
			},
			cancellationRequestBadgeTR: (status) => {
				const s = String(status || '').trim().toLowerCase();
					const app = (document.body && document.body.dataset && document.body.dataset.app) ? String(document.body.dataset.app) : '';
					const noun = app === 'shop' ? 'İade Talebi' : 'İptal Talebi';
					if (s === 'approved') return { text: `${noun} Onaylandı`, cls: 'ui-accent' };
					if (s === 'rejected') return { text: `${noun} Reddedildi`, cls: 'ui-muted' };
					if (s === 'cancelled') return { text: `${noun} İptal`, cls: 'ui-muted' };
					if (s === 'requested') return { text: `${noun} Alındı`, cls: 'ui-accent' };
					return { text: `${noun} Alındı`, cls: 'ui-accent' };
			},
		};
	}

	const DEFAULT_SOCKET_OPTIONS = {
		withCredentials: true,
		reconnection: true,
		reconnectionAttempts: Infinity,
		reconnectionDelay: 500,
		reconnectionDelayMax: 4000,
	};

	function ensureToastHost() {
		let host = document.getElementById('rtToastHost');
		if (host) return host;
		host = document.createElement('div');
		host.id = 'rtToastHost';
		host.className = 'fixed top-4 right-4 z-50 flex flex-col gap-2';
		document.body.appendChild(host);
		return host;
	}

	function showToast(message) {
		try {
			const host = ensureToastHost();
			const el = document.createElement('div');
			el.className = 'ui-card ui-border rounded-xl px-4 py-3 text-sm bg-[color:var(--bg-elevated)] text-[color:var(--text-primary)]';
			el.style.opacity = '0';
			el.style.transform = 'translateY(-6px)';
			el.style.transition = 'opacity 180ms ease, transform 180ms ease';
			el.textContent = String(message || '');
			host.appendChild(el);
			requestAnimationFrame(() => {
				el.style.opacity = '1';
				el.style.transform = 'translateY(0px)';
			});
			window.setTimeout(() => {
				el.style.opacity = '0';
				el.style.transform = 'translateY(-6px)';
				window.setTimeout(() => el.remove(), 220);
			}, 3500);
		} catch {
			// ignore
		}
	}

	function ensureBanner() {
		let banner = document.getElementById('rtLiveBanner');
		if (banner) return banner;
		banner = document.createElement('div');
		banner.id = 'rtLiveBanner';
		banner.className = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[92vw]';
		banner.style.display = 'none';
		banner.innerHTML = `
			<div class="ui-card ui-border rounded-2xl px-4 py-3 bg-[color:var(--bg-elevated)] text-[color:var(--text-primary)] shadow">
				<div class="flex items-center justify-between gap-3">
					<p id="rtLiveBannerText" class="text-sm"></p>
					<div class="flex items-center gap-2">
						<button id="rtLiveBannerReload" class="ui-btn ui-btn-primary">Yenile</button>
						<button id="rtLiveBannerClose" class="ui-btn ui-btn-secondary">Kapat</button>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(banner);
		banner.querySelector('#rtLiveBannerReload')?.addEventListener('click', () => window.location.reload());
		banner.querySelector('#rtLiveBannerClose')?.addEventListener('click', () => {
			banner.style.display = 'none';
		});
		return banner;
	}

	function showBanner(message) {
		try {
			const banner = ensureBanner();
			const textEl = banner.querySelector('#rtLiveBannerText');
			if (textEl) textEl.textContent = String(message || 'Güncelleme var.');
			banner.style.display = 'block';
		} catch {
			// ignore
		}
	}

	function getDomSubscribePayload() {
		const body = document.body;
		if (!body) return null;
		const orderId = String(body.dataset.rtOrderId || '').trim();
		const trackingCode = String(body.dataset.rtTrackingCode || '').trim();
		if (!orderId && !trackingCode) return null;
		return {
			orderId: orderId || null,
			trackingCode: trackingCode || null,
		};
	}

	function subscribeIfNeeded(socket) {
		const payload = getDomSubscribePayload();
		if (!payload) return;
		try {
			socket.emit('subscribe', payload);
		} catch {
			// ignore
		}
	}

	function sameOrderAsCurrent(payload) {
		const body = document.body;
		if (!body) return false;
		const currentOrderId = String(body.dataset.rtOrderId || '').trim();
		const currentTracking = String(body.dataset.rtTrackingCode || '').trim();
		const orderId = String(payload?.orderId || '').trim();
		const trackingCode = String(payload?.trackingCode || '').trim();
		if (currentOrderId && orderId && currentOrderId === orderId) return true;
		if (currentTracking && trackingCode && currentTracking === trackingCode) return true;
		return false;
	}

	function bindGenericHandlers(socket) {
		if (socket.__rtBound) return;
		socket.__rtBound = true;

		const getLabels = () => window.__STATUS_LABELS_TR__ || {};
		const orderStatusLabelTR = (status) => {
			const fn = getLabels().orderStageLabelTR;
			return typeof fn === 'function' ? fn(status) : (String(status || '').trim() || '—');
		};
		const cancelReqLabelTR = (status) => {
			const fn = getLabels().cancellationRequestBadgeTR;
			const app = (document.body && document.body.dataset && document.body.dataset.app) ? String(document.body.dataset.app) : '';
			const fallbackText = app === 'shop' ? 'İade Talebi Alındı' : 'İptal Talebi Alındı';
			return typeof fn === 'function' ? fn(status) : { text: fallbackText, cls: 'ui-accent' };
		};

		function setElVisible(el, visible) {
			if (!el) return;
			el.classList.toggle('hidden', !visible);
		}

		function updateOrderStatusDom(orderId, status) {
			const id = String(orderId || '').trim();
			if (!id) return false;
			const label = orderStatusLabelTR(status);
			let touched = false;

			// Customer orders page
			document.querySelectorAll(`[data-order-status][data-order-id="${CSS.escape(id)}"], [data-order-status-mobile][data-order-id="${CSS.escape(id)}"]`).forEach((el) => {
				el.textContent = label;
				touched = true;
			});

			// ShopAdmin list / detail
			document.querySelectorAll(`[data-rt-order-status-label][data-order-id="${CSS.escape(id)}"]`).forEach((el) => {
				el.textContent = label;
				touched = true;
			});
			document.querySelectorAll(`[data-rt-order-status-select][data-order-id="${CSS.escape(id)}"]`).forEach((sel) => {
				try {
					if (sel && String(sel.value || '') !== String(status || '')) {
						sel.value = String(status || '');
						touched = true;
					}
				} catch {
					// ignore
				}
			});

			return touched;
		}

		function updateCancellationDom(orderId, status, adminNote) {
			const id = String(orderId || '').trim();
			if (!id) return false;
			const info = cancelReqLabelTR(status);
			const normalized = String(status || '').trim().toLowerCase();
			const isOpen = normalized === 'requested';
			let touched = false;

			// Badges (shop orders + track + shopAdmin)
			document.querySelectorAll(`[data-rt-cancel-badge][data-order-id="${CSS.escape(id)}"]`).forEach((el) => {
				el.textContent = info.text;
				el.dataset.rtCancelStatus = String(status || '');
				el.classList.remove('ui-accent', 'ui-muted');
				el.classList.add(info.cls);
				setElVisible(el, isOpen);
				touched = true;
			});

			// Optional container (shopAdmin list)
			document.querySelectorAll(`[data-rt-cancel-container][data-order-id="${CSS.escape(id)}"]`).forEach((el) => {
				setElVisible(el, isOpen);
				touched = true;
			});

			// Notes (only meaningful on rejected)
			const noteText = String(adminNote || '').trim();
			const showNote = normalized === 'rejected' && !!noteText;
			document.querySelectorAll(`[data-rt-cancel-note][data-order-id="${CSS.escape(id)}"]`).forEach((el) => {
				const textEl = el.querySelector('[data-rt-cancel-note-text]');
				if (textEl) textEl.textContent = noteText;
				setElVisible(el, showNote);
				touched = true;
			});

			return touched;
		}

		socket.on('connect', () => {
			subscribeIfNeeded(socket);
		});
		socket.on('reconnect', () => {
			subscribeIfNeeded(socket);
		});

		socket.on('orderStatusChanged', (payload) => {
			const orderId = String(payload?.orderId || '').trim();
			const status = String(payload?.status || '').trim();
			const statusText = orderStatusLabelTR(status);
			showToast(`Sipariş durumu güncellendi${orderId ? ` (#${orderId})` : ''}${statusText ? `: ${statusText}` : ''}`);
			const domTouched = updateOrderStatusDom(orderId, status);
			if (sameOrderAsCurrent(payload)) {
				if (!domTouched) showBanner('Sipariş bilgileri güncellendi.');
			}
		});

		socket.on('cancellationRequestUpdated', (payload) => {
			const orderId = String(payload?.orderId || '').trim();
			const status = String(payload?.status || '').trim();
			const info = cancelReqLabelTR(status);
				{
					const app = (document.body && document.body.dataset && document.body.dataset.app) ? String(document.body.dataset.app) : '';
					const nounLower = app === 'shop' ? 'İade talebi' : 'İptal talebi';
					showToast(`${nounLower} güncellendi${orderId ? ` (#${orderId})` : ''}${info?.text ? `: ${info.text}` : ''}`);
				}
			const domTouched = updateCancellationDom(orderId, status, payload?.adminNote || payload?.admin_note);
			if (sameOrderAsCurrent(payload)) {
				if (!domTouched) showBanner('İptal talebi durumu güncellendi.');
							if (!domTouched) {
								const app = (document.body && document.body.dataset && document.body.dataset.app) ? String(document.body.dataset.app) : '';
								showBanner(app === 'shop' ? 'İade talebi durumu güncellendi.' : 'İptal talebi durumu güncellendi.');
							}
			}
		});
	}

	function getRealtimeSocket() {
		if (window.__rt_socket) return window.__rt_socket;
		const socket = window.io(DEFAULT_SOCKET_OPTIONS);
		window.__rt_socket = socket;
		bindGenericHandlers(socket);
		subscribeIfNeeded(socket);
		return socket;
	}

	window.__getRealtimeSocket = getRealtimeSocket;

	// Auto-connect on every page
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => {
			getRealtimeSocket();
		});
	} else {
		getRealtimeSocket();
	}
})();
