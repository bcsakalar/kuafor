// Shop customer orders realtime hooks
(() => {
	if (typeof window.io !== 'function') return;

	function statusLabelTR(status) {
		const fn = window.__STATUS_LABELS_TR__?.orderStageLabelTR;
		if (typeof fn === 'function') return fn(status);
		const s = String(status || '').trim().toLowerCase();
		return s === 'pending'
			? 'Sipariş Alındı'
			: s === 'shipped'
				? 'Kargoya Verildi'
				: s === 'completed'
					? 'Teslim Edildi'
					: s === 'cancelled'
						? 'İptal Edildi'
						: (status || '');
	}

	function setStatusForOrder(orderId, status) {
		const id = String(orderId || '').trim();
		if (!id) return;
		const label = statusLabelTR(status);
		// Desktop table
		const desk = document.querySelector(`[data-order-status][data-order-id="${CSS.escape(id)}"]`);
		if (desk) desk.textContent = label;
		// Mobile cards
		const mob = document.querySelector(`[data-order-status-mobile][data-order-id="${CSS.escape(id)}"]`);
		if (mob) mob.textContent = label;
	}

	function bindRealtime() {
		// Rooms are assigned server-side from session (customer:<userId>).
		const socket = typeof window.__getRealtimeSocket === 'function'
			? window.__getRealtimeSocket()
			: window.io({
				withCredentials: true,
				reconnection: true,
				reconnectionAttempts: Infinity,
				reconnectionDelay: 500,
				reconnectionDelayMax: 4000,
			});

		socket.on('orderStatusChanged', (payload) => {
			try {
				setStatusForOrder(payload?.orderId, payload?.status);
			} catch {
				// ignore
			}
		});

		socket.on('disconnect', () => {
			// reconnection is automatic
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindRealtime);
	} else {
		bindRealtime();
	}
})();
