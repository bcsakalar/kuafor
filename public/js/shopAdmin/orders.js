// Shop Admin orders realtime hooks
(() => {
	const listEl = document.getElementById('shopAdminOrdersList');
	if (!listEl) return;
	if (typeof window.io !== 'function') return;

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
	}

	function playDing() {
		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) return;
			const ctx = new Ctx();
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = 'sine';
			osc.frequency.value = 880;
			gain.gain.value = 0.0001;
			osc.connect(gain);
			gain.connect(ctx.destination);
			const now = ctx.currentTime;
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
			osc.start(now);
			osc.stop(now + 0.25);
			osc.onended = () => {
				ctx.close?.().catch?.(() => {});
			};
		} catch {
			// ignore
		}
	}

	function escapeHtml(s) {
		return String(s)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function prependOrderRow(payload) {
		const orderId = String(payload?.orderId || '').trim();
		const totalAmount = payload?.totalAmount;
		const amountText = (typeof totalAmount === 'number' && Number.isFinite(totalAmount))
			? `${totalAmount.toFixed(2)} ₺`
			: '';

		const stageLabel = typeof window.__STATUS_LABELS_TR__?.orderStageLabelTR === 'function'
			? window.__STATUS_LABELS_TR__.orderStageLabelTR('pending')
			: 'Sipariş Alındı';
		const cancelLabel = typeof window.__STATUS_LABELS_TR__?.cancellationRequestBadgeTR === 'function'
			? window.__STATUS_LABELS_TR__.cancellationRequestBadgeTR('requested')?.text
			: 'İptal Talebi Alındı';

		// Minimal placeholder row (details can be viewed from the detail page).
		const wrapper = document.createElement('div');
		wrapper.className = 'border ui-border rounded-xl p-4';
		wrapper.style.opacity = '0';
		wrapper.style.transform = 'translateY(-6px)';
		wrapper.style.transition = 'opacity 180ms ease, transform 180ms ease';
		wrapper.innerHTML = `
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p class="font-semibold"><a class="underline" href="/orders/${encodeURIComponent(orderId)}">Sipariş #${escapeHtml(orderId || '-')}</a></p>
					<p class="mt-1 text-sm ui-muted">${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })} • <span class="border ui-border rounded-full px-2 py-0.5 text-xs" data-rt-order-status-label data-order-id="${escapeHtml(orderId)}">${escapeHtml(stageLabel)}</span><span data-rt-cancel-container data-order-id="${escapeHtml(orderId)}" class="hidden"> • <span class="border ui-border rounded-full px-2 py-0.5 text-xs" data-rt-cancel-badge data-order-id="${escapeHtml(orderId)}" data-rt-cancel-status="">${escapeHtml(cancelLabel || '')}</span></span>${amountText ? ` • ${escapeHtml(amountText)}` : ''}</p>
				</div>
				<div class="flex items-center gap-2">
					<a class="ui-btn ui-btn-secondary" href="/orders/${encodeURIComponent(orderId)}">Detay</a>
				</div>
			</div>
		`;

		if (listEl.firstChild) listEl.insertBefore(wrapper, listEl.firstChild);
		else listEl.appendChild(wrapper);

		requestAnimationFrame(() => {
			wrapper.style.opacity = '1';
			wrapper.style.transform = 'translateY(0px)';
		});
	}

	function bindRealtime() {
		const socket = typeof window.__getRealtimeSocket === 'function'
			? window.__getRealtimeSocket()
			: window.io({
				withCredentials: true,
				reconnection: true,
				reconnectionAttempts: Infinity,
				reconnectionDelay: 500,
				reconnectionDelayMax: 4000,
			});

		socket.on('newOrder', (payload) => {
			playDing();
			prependOrderRow(payload);

			const orderId = String(payload?.orderId || '').trim();
			showToast(`Yeni Sipariş Geldi!${orderId ? ` #${orderId}` : ''}`);
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
