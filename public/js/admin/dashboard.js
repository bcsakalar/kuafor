// Admin dashboard DOM hooks
(() => {
	const adminBasePath = (typeof window.__ADMIN_BASE_PATH__ === 'string') ? window.__ADMIN_BASE_PATH__ : '';
	const apiBase = adminBasePath ? `${adminBasePath}/api` : '/api';

	const recentList = document.getElementById('recentAppointmentsList');
	const recentEmpty = document.getElementById('recentAppointmentsEmpty');

	const input = document.getElementById('apptSearchCode');
	const btn = document.getElementById('apptSearchBtn');
	const msg = document.getElementById('apptSearchMsg');
	const result = document.getElementById('apptSearchResult');
	if (!input || !btn || !msg || !result) return;

	function escapeHtml(s) {
		return String(s)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function fmtDate(iso) {
		try {
			return new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
		} catch {
			return iso;
		}
	}

	async function fetchAppointmentById(id) {
		const res = await fetch(`${apiBase}/appointments/${encodeURIComponent(id)}`, {
			method: 'GET',
			credentials: 'include',
		});
		if (res.status === 404) return { appointment: null, notFound: true };
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	function renderAppointmentCard(a) {
		const services = Array.isArray(a.services) ? a.services : [];
		const servicesText = services.length ? services.map((s) => s.name).join(', ') : '-';
		const categoryText = a.category === 'men' ? 'Erkek Kuaförü' : a.category === 'women' ? 'Güzellik Salonu' : a.category;
		const notes = a.notes ? escapeHtml(a.notes) : '';

		return `
			<div class="ui-card ui-border rounded-xl p-4">
				<div class="flex flex-col gap-1 text-sm">
					<div><span class="ui-muted">Kod:</span> <span class="font-mono">${escapeHtml(a.id)}</span></div>
					<div><span class="ui-muted">Şube:</span> ${escapeHtml(categoryText)}</div>
					<div><span class="ui-muted">Tarih:</span> ${escapeHtml(fmtDate(a.starts_at))} - ${escapeHtml(fmtDate(a.ends_at))}</div>
					<div><span class="ui-muted">Müşteri:</span> ${escapeHtml(a.customer_full_name || '-')} (${escapeHtml(a.customer_phone || '-')})</div>
					<div><span class="ui-muted">Personel:</span> ${escapeHtml(a.staff_full_name || '-')}</div>
					<div><span class="ui-muted">Hizmet:</span> ${escapeHtml(servicesText)}</div>
					${notes ? `<div><span class="ui-muted">Not:</span> ${notes}</div>` : ''}
				</div>
			</div>
		`;
	}

	async function runSearch() {
		const code = String(input.value || '').trim();
		result.innerHTML = '';
		msg.className = 'mt-2 text-sm ui-muted';
		msg.textContent = '';
		if (!code) {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Lütfen randevu kodunu girin.';
			return;
		}

		try {
			msg.textContent = 'Aranıyor...';
			const data = await fetchAppointmentById(code);
			if (data?.notFound || !data?.appointment) {
				msg.className = 'mt-2 text-sm text-red-700';
				msg.textContent = 'Randevu bulunamadı.';
				return;
			}
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = 'Randevu bulundu.';
			result.innerHTML = renderAppointmentCard(data.appointment);
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Arama hatası.';
		}
	}

	btn.addEventListener('click', runSearch);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') runSearch();
	});

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

	function prependRecentAppointment(payload) {
		if (!recentList) return;
		if (recentEmpty) recentEmpty.classList.add('hidden');

		const name = String(payload?.customerName || '-');
		const date = String(payload?.date || '').trim();
		const time = String(payload?.time || '').trim();
		const service = String(payload?.service || '').trim();

		const li = document.createElement('li');
		li.className = 'border ui-border rounded-lg px-3 py-2 bg-[color:var(--bg-elevated)]';
		li.style.opacity = '0';
		li.style.transform = 'translateY(-6px)';
		li.style.transition = 'opacity 180ms ease, transform 180ms ease';
		li.innerHTML = `
			<div class="flex items-start justify-between gap-3">
				<div>
					<div class="text-sm font-medium">${escapeHtml(name)}${time ? ` • ${escapeHtml(time)}` : ''}</div>
					<div class="text-xs ui-muted mt-0.5">${escapeHtml(date || '-')}${service ? ` • ${escapeHtml(service)}` : ''}</div>
				</div>
			</div>
		`;

		if (recentList.firstChild) recentList.insertBefore(li, recentList.firstChild);
		else recentList.appendChild(li);

		requestAnimationFrame(() => {
			li.style.opacity = '1';
			li.style.transform = 'translateY(0px)';
		});

		// Keep list short
		while (recentList.children.length > 8) {
			recentList.lastChild?.remove();
		}
	}

	function bindRealtime() {
		if (typeof window.io !== 'function') return;
		const socket = typeof window.__getRealtimeSocket === 'function'
			? window.__getRealtimeSocket()
			: window.io({
				withCredentials: true,
				reconnection: true,
				reconnectionAttempts: Infinity,
				reconnectionDelay: 500,
				reconnectionDelayMax: 4000,
			});
		socket.on('newAppointment', (payload) => {
			try {
				const name = String(payload?.customerName || '-');
				const time = String(payload?.time || '').trim();
				showToast(`Yeni Randevu: ${name}${time ? ` - ${time}` : ''}`);
			} catch {
				// ignore
			}
			prependRecentAppointment(payload);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindRealtime);
	} else {
		bindRealtime();
	}
})();

// Admin dashboard charts
(() => {
	const analytics = window.__DASHBOARD_ANALYTICS__ || {};
	const series = Array.isArray(analytics.last7DaysRevenue) ? analytics.last7DaysRevenue : [];
	const occupancy = analytics.occupancy || {};

	const revenueCanvas = document.getElementById('revenue7dChart');
	const pieCanvas = document.getElementById('occupancyPieChart');
	if (!revenueCanvas || !pieCanvas) return;
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

	// Line chart: revenue
	new window.Chart(revenueCanvas.getContext('2d'), {
		type: 'line',
		data: {
			labels,
			datasets: [
				{
					label: 'Randevu Geliri (₺)',
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
						label: (ctx) => {
							const v = Number(ctx.parsed.y || 0);
							return `${v.toFixed(2)} ₺`;
						},
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

	// Pie chart: occupancy
	const booked = Number(occupancy.booked_slots || 0);
	const free = Number(occupancy.free_slots || 0);
	new window.Chart(pieCanvas.getContext('2d'), {
		type: 'pie',
		data: {
			labels: ['Dolu', 'Boş'],
			datasets: [
				{
					data: [booked, free],
				}
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { position: 'bottom' },
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.label}: ${Number(ctx.parsed || 0)} slot`,
					},
				},
			},
		}
	});
})();
