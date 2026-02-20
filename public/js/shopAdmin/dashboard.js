(() => {
	const data = window.__SHOPADMIN_DASHBOARD__ || {};
	const series = Array.isArray(data.last7DaysShopRevenue) ? data.last7DaysShopRevenue : [];

	const canvas = document.getElementById('shopRevenue7dChart');
	if (!canvas) return;
	if (typeof window.Chart !== 'function') return;

	function fmtLabel(dateStr) {
		try {
			const d = new Date(dateStr);
			return d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit' });
		} catch {
			return String(dateStr || '').slice(0, 10);
		}
	}

	const labels = series.map((x) => fmtLabel(x.date));
	const values = series.map((x) => Number(x.revenue || 0));

	new window.Chart(canvas.getContext('2d'), {
		type: 'line',
		data: {
			labels,
			datasets: [
				{
					label: 'Shop Geliri (₺)',
					data: values,
					tension: 0.25,
					fill: false,
				}
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `${Number(ctx.parsed.y || 0).toFixed(2)} ₺`,
					},
				},
			},
			scales: {
				y: {
					beginAtZero: true,
					ticks: {
						callback: (v) => `${Number(v).toFixed(0)} ₺`,
					},
				},
			},
		}
	});
})();

// Shop Admin realtime hooks
(() => {
	const pendingEl = document.getElementById('shopPendingOrdersCount');
	const recentOrdersEl = document.getElementById('shopAdminRecentOrders');
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
		// No external files; small WebAudio beep.
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

	function bumpPendingCount() {
		if (!pendingEl) return;
		const current = Number(String(pendingEl.textContent || '').trim());
		pendingEl.textContent = String(Number.isFinite(current) ? (current + 1) : 1);
	}

	function escapeHtml(s) {
		return String(s)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function prependRecentOrderCard(payload) {
		if (!recentOrdersEl) return;

		// Remove empty placeholder if present.
		const onlyChild = recentOrdersEl.children.length === 1 ? recentOrdersEl.children[0] : null;
		if (onlyChild && onlyChild.tagName === 'P' && String(onlyChild.textContent || '').toLowerCase().includes('henüz sipariş yok')) {
			onlyChild.remove();
		}

		const orderId = String(payload?.orderId || '').trim();
		const totalAmount = payload?.totalAmount;
		const amountText = (typeof totalAmount === 'number' && Number.isFinite(totalAmount))
			? `${totalAmount.toFixed(2)} ₺`
			: '';

		const el = document.createElement('div');
		el.className = 'flex items-center justify-between gap-4 border ui-border rounded-xl p-3';
		el.style.opacity = '0';
		el.style.transform = 'translateY(-6px)';
		el.style.transition = 'opacity 180ms ease, transform 180ms ease';
		el.innerHTML = `
			<div>
				<p class="font-semibold"><a class="underline" href="/orders/${encodeURIComponent(orderId)}">#${escapeHtml(orderId || '-') }</a></p>
				<p class="text-sm ui-muted"><span class="border ui-border rounded-full px-2 py-0.5 text-xs">Sipariş Alındı</span> • 0 ürün • ${escapeHtml(new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' }))}</p>
			</div>
			<p class="font-semibold">${escapeHtml(amountText || '-') }</p>
		`;

		if (recentOrdersEl.firstChild) recentOrdersEl.insertBefore(el, recentOrdersEl.firstChild);
		else recentOrdersEl.appendChild(el);

		requestAnimationFrame(() => {
			el.style.opacity = '1';
			el.style.transform = 'translateY(0px)';
		});

		// Keep short
		while (recentOrdersEl.children.length > 10) {
			recentOrdersEl.lastChild?.remove();
		}
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
			bumpPendingCount();
			playDing();
			prependRecentOrderCard(payload);
			const orderId = String(payload?.orderId || '').trim();
			const totalAmount = payload?.totalAmount;
			const amountText = (typeof totalAmount === 'number' && Number.isFinite(totalAmount))
				? `${totalAmount.toFixed(2)} ₺`
				: '';
			showToast(`Yeni Sipariş Geldi!${orderId ? ` #${orderId}` : ''}${amountText ? ` • ${amountText}` : ''}`);
		});

		socket.on('disconnect', () => {
			// reconnection is automatic; optional UI could be added here
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindRealtime);
	} else {
		bindRealtime();
	}
})();
