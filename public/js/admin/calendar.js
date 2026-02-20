// Admin calendar DOM hooks
(() => {
	const adminBasePath = (typeof window.__ADMIN_BASE_PATH__ === 'string') ? window.__ADMIN_BASE_PATH__ : '';
	const apiBasePath = adminBasePath ? `${adminBasePath}/api` : '/api';

	const IST_TZ = 'Europe/Istanbul';
	const IST_OFFSET_MINUTES = 180; // Turkey is UTC+3 year-round

	const modeListBtn = document.getElementById('calModeList');
	const modeCalBtn = document.getElementById('calModeCalendar');
	const listControls = document.getElementById('calListControls');
	const calControls = document.getElementById('calCalendarControls');
	const viewSelect = document.getElementById('calView');
	const branchSelect = document.getElementById('calBranch');
	const staffSelect = document.getElementById('calStaff');
	const focusInput = document.getElementById('calFocus');
	const prevBtn = document.getElementById('calPrev');
	const nextBtn = document.getElementById('calNext');
	const todayBtn = document.getElementById('calToday');
	const rangeLabel = document.getElementById('calRangeLabel');
	const listWrap = document.getElementById('calListWrap');
	const calWrap = document.getElementById('calCalendarWrap');
	const gridEl = document.getElementById('calendarGrid');
	const dayTitleEl = document.getElementById('calDayTitle');
	const dayCountEl = document.getElementById('calDayCount');
	const dayDetailsEl = document.getElementById('calDayDetails');

	const startInput = document.getElementById('calStart');
	const endInput = document.getElementById('calEnd');
	const loadBtn = document.getElementById('calLoad');
	const statusEl = document.getElementById('calStatus');
	const menEl = document.getElementById('calendarMen');
	const womenEl = document.getElementById('calendarWomen');

	if (!startInput || !endInput || !loadBtn || !statusEl || !menEl || !womenEl) return;
	if (!modeListBtn || !modeCalBtn || !listControls || !calControls || !viewSelect || !focusInput || !prevBtn || !nextBtn || !todayBtn || !rangeLabel || !listWrap || !calWrap || !gridEl) return;
	if (!branchSelect) return;
	if (!staffSelect) return;
	if (!dayTitleEl || !dayCountEl || !dayDetailsEl) return;

	let mode = 'list'; // list | calendar
	let calView = 'month'; // month | week | day
	let focusDate = new Date();
	let branch = 'all'; // all | men | women
	let staffId = 'all'; // all | uuid
	let selectedDayKey = null;
	let selectedAppointmentId = null;
	let lastCalendarApptsRaw = [];
	let editingAppointmentId = null;
	let staffCache = { men: null, women: null };

	function pad2(n) {
		return String(n).padStart(2, '0');
	}

	function getIstanbulYMD(date) {
		const parts = new Intl.DateTimeFormat('tr-TR', {
			timeZone: IST_TZ,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(date);
		const year = Number(parts.find((p) => p.type === 'year')?.value);
		const month = Number(parts.find((p) => p.type === 'month')?.value);
		const day = Number(parts.find((p) => p.type === 'day')?.value);
		return { year, month, day };
	}

	function getIstanbulHM(date) {
		const parts = new Intl.DateTimeFormat('tr-TR', {
			timeZone: IST_TZ,
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).formatToParts(date);
		const hour = Number(parts.find((p) => p.type === 'hour')?.value);
		const minute = Number(parts.find((p) => p.type === 'minute')?.value);
		return { hour, minute };
	}

	function toDateInputValue(d) {
		return dateKeyLocal(d);
	}

	function startOfLocalDay(dateStr) {
		const [y, m, d] = dateStr.split('-').map((x) => Number(x));
		return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MINUTES * 60_000);
	}

	function startOfDay(date) {
		return startOfLocalDay(dateKeyLocal(date));
	}

	function startOfWeek(date) {
		const key = dateKeyLocal(date);
		const [y, m, d] = key.split('-').map((x) => Number(x));
		const weekdaySun0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
		const weekdayMon0 = (weekdaySun0 + 6) % 7; // Mon=0..Sun=6
		return addDays(startOfLocalDay(key), -weekdayMon0);
	}

	function endExclusiveOfDay(date) {
		return addDays(startOfDay(date), 1);
	}

	function addDays(date, days) {
		return new Date(date.getTime() + Number(days) * 24 * 60 * 60_000);
	}

	function escapeHtml(s) {
		return String(s)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function cssEscape(s) {
		if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(s));
		return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
	}

	function formatTime(iso) {
		return new Date(iso).toLocaleTimeString('tr-TR', {
			timeZone: IST_TZ,
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	function formatDayLabel(date) {
		return date.toLocaleDateString('tr-TR', { timeZone: IST_TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	function formatShortDay(date) {
		return date.toLocaleDateString('tr-TR', { timeZone: IST_TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
	}

	function formatLongDay(date) {
		return date.toLocaleDateString('tr-TR', { timeZone: IST_TZ, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
	}

	function dateKeyLocal(date) {
		const { year, month, day } = getIstanbulYMD(date);
		return `${year}-${pad2(month)}-${pad2(day)}`;
	}

	function apptDayKey(a) {
		return dateKeyLocal(new Date(a.starts_at));
	}

	function fmtPhone(s) {
		return String(s || '').trim();
	}

	function groupByDay(appts) {
		const map = new Map();
		for (const a of appts) {
			const key = dateKeyLocal(new Date(a.starts_at));
			if (!map.has(key)) map.set(key, []);
			map.get(key).push(a);
		}
		return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
	}

	function renderList(rootEl, appts) {
		if (!appts.length) {
			rootEl.innerHTML = '<div class="text-sm ui-muted">Bu aralıkta randevu yok.</div>';
			return;
		}

		const days = groupByDay(appts);
		rootEl.innerHTML = days
			.map(([day, items]) => {
				const rows = items
					.map((a) => {
						const services = Array.isArray(a.services)
							? a.services.map((s) => s?.name).filter(Boolean).join(', ')
							: '';
						const statusBadge = a.status && a.status !== 'booked'
							? `<span class="ml-2 text-xs px-2 py-0.5 rounded border ui-border bg-[color:var(--bg-primary)]">${escapeHtml(a.status)}</span>`
							: '';
						return `
							<div class="ui-card ui-border rounded-xl p-3">
								<div class="flex items-start justify-between gap-3">
									<div>
										<div class="font-medium">${escapeHtml(formatTime(a.starts_at))} - ${escapeHtml(formatTime(a.ends_at))}${statusBadge}</div>
										<div class="text-sm ui-muted mt-1">${escapeHtml(a.customer_full_name || '-')}${a.staff_full_name ? ` • <span class=\"ui-muted\">${escapeHtml(a.staff_full_name)}</span>` : ''}</div>
										${services ? `<div class=\"text-xs ui-muted mt-1\">${escapeHtml(services)}</div>` : ''}
									</div>
								</div>
							</div>
						`;
					})
					.join('');
				return `
					<div class="mb-4">
						<div class="text-sm font-semibold mb-2">${escapeHtml(day)}</div>
						<div class="grid gap-2">${rows}</div>
					</div>
				`;
			})
			.join('');
	}

	function toTimeInputValue(iso) {
		return new Date(iso).toLocaleTimeString('tr-TR', {
			timeZone: IST_TZ,
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	function timeOnDay(dayKey, hhmm) {
		if (!dayKey || !hhmm) return null;
		const [h, m] = String(hhmm).split(':').map((x) => Number(x));
		const base = startOfLocalDay(dayKey);
		return new Date(base.getTime() + ((h || 0) * 60 + (m || 0)) * 60_000);
	}

	async function fetchStaff(category) {
		if (!category || !['men', 'women'].includes(category)) return [];
		if (staffCache[category]) return staffCache[category];
		const url = new URL(`${apiBasePath}/staff`, window.location.origin);
		url.searchParams.set('category', category);
		const resp = await fetch(url.toString(), { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' });
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const data = await resp.json();
		staffCache[category] = Array.isArray(data.staff) ? data.staff : [];
		return staffCache[category];
	}

	function uniqById(items) {
		const map = new Map();
		for (const it of items || []) {
			const id = String(it?.id || '').trim();
			if (!id) continue;
			if (!map.has(id)) map.set(id, it);
		}
		return Array.from(map.values());
	}

	async function loadStaffOptions() {
		try {
			const scope = mode === 'list' ? 'all' : branch;
			let staff = [];
			if (scope === 'men' || scope === 'women') {
				staff = await fetchStaff(scope);
			} else {
				const [men, women] = await Promise.all([fetchStaff('men'), fetchStaff('women')]);
				staff = uniqById([...(men || []), ...(women || [])]);
			}

			const options = staff
				.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || '-')}${s.category === 'both' ? ' (her ikisi)' : ''}</option>`)
				.join('');
			staffSelect.innerHTML = `<option value="all">Tümü</option>${options}`;

			if (staffId && staffId !== 'all') {
				const has = staff.some((s) => String(s.id) === String(staffId));
				if (has) staffSelect.value = String(staffId);
				else {
					staffId = 'all';
					staffSelect.value = 'all';
				}
			} else {
				staffSelect.value = 'all';
			}
		} catch {
			staffSelect.innerHTML = '<option value="all">Tümü</option>';
			staffId = 'all';
			staffSelect.value = 'all';
		}
	}

	function buildEventTitle(a) {
		const who = a.customer_full_name || '-';
		const staff = a.staff_full_name ? ` • ${a.staff_full_name}` : '';
		const prefix = a.category === 'men' ? 'E' : 'K';
		return `${prefix} ${formatTime(a.starts_at)} ${who}${staff}`;
	}

	function groupEventsByDay(appts) {
		const map = new Map();
		for (const a of appts) {
			const key = apptDayKey(a);
			if (!map.has(key)) map.set(key, []);
			map.get(key).push(a);
		}
		for (const [k, arr] of map.entries()) {
			arr.sort((x, y) => (x.starts_at < y.starts_at ? -1 : 1));
			map.set(k, arr);
		}
		return map;
	}

	function getVisibleAppts() {
		let out = lastCalendarApptsRaw;
		if (branch === 'men' || branch === 'women') out = out.filter((a) => a.category === branch);
		if (staffId && staffId !== 'all') out = out.filter((a) => String(a.staff_id || '') === String(staffId));
		return out;
	}

	function clamp(n, min, max) {
		return Math.max(min, Math.min(max, n));
	}

	function layoutDayItems(items, startHour, totalMinutes) {
		const positioned = items
			.map((a) => {
				const start = new Date(a.starts_at);
				const end = new Date(a.ends_at);
				const startHm = getIstanbulHM(start);
				const endHm = getIstanbulHM(end);
				const startMinAbs = startHm.hour * 60 + startHm.minute;
				const endMinAbs = endHm.hour * 60 + endHm.minute;
				const startMin = clamp(startMinAbs - startHour * 60, 0, totalMinutes);
				const endMin = clamp(endMinAbs - startHour * 60, 0, totalMinutes);
				const safeEnd = endMin > startMin ? endMin : Math.min(totalMinutes, startMin + 15);
				return { a, startMin, endMin: safeEnd, lane: 0, lanes: 1 };
			})
			.sort((x, y) => (x.startMin !== y.startMin ? x.startMin - y.startMin : y.endMin - x.endMin));

		const clusters = [];
		let cur = [];
		let curEnd = -1;
		for (const ev of positioned) {
			if (!cur.length) {
				cur = [ev];
				curEnd = ev.endMin;
				continue;
			}
			if (ev.startMin >= curEnd) {
				clusters.push(cur);
				cur = [ev];
				curEnd = ev.endMin;
				continue;
			}
			cur.push(ev);
			curEnd = Math.max(curEnd, ev.endMin);
		}
		if (cur.length) clusters.push(cur);

		for (const cluster of clusters) {
			const lanesEnd = [];
			for (const ev of cluster) {
				let laneIdx = lanesEnd.findIndex((endMin) => ev.startMin >= endMin);
				if (laneIdx === -1) {
					laneIdx = lanesEnd.length;
					lanesEnd.push(ev.endMin);
				} else {
					lanesEnd[laneIdx] = ev.endMin;
				}
				ev.lane = laneIdx;
			}
			const lanesCount = lanesEnd.length || 1;
			for (const ev of cluster) ev.lanes = lanesCount;
		}

		return positioned;
	}

	function renderMonth(rootEl, rangeStart, appts) {
		const eventsByDay = groupEventsByDay(appts);
		const days = [];
		for (let i = 0; i < 42; i++) days.push(addDays(rangeStart, i));

		const headers = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz']
			.map((h) => `<div class="px-2 py-2 text-xs font-semibold ui-muted">${h}</div>`)
			.join('');

		const cells = days
			.map((d) => {
				const key = dateKeyLocal(d);
				const items = eventsByDay.get(key) || [];
				const dayNum = getIstanbulYMD(d).day;
				const maxShow = 3;
				const shown = items.slice(0, maxShow);
				const more = items.length > maxShow ? items.length - maxShow : 0;
				const chips = shown
					.map((a) => {
						const border = a.category === 'men' ? 'border-[color:var(--text-primary)]' : 'border-[color:var(--border)]';
						return `<div class="text-xs truncate px-2 py-1 rounded border ui-border ${border} bg-[color:var(--bg-primary)]">${escapeHtml(buildEventTitle(a))}</div>`;
					})
					.join('');
				const moreHtml = more ? `<div class="text-xs ui-muted px-2">+${more}</div>` : '';
				const selected = selectedDayKey && selectedDayKey === key;
				const ring = selected ? 'ring-2 ring-[color:var(--accent)]' : '';
				return `
					<button type="button" data-cal-day="${key}" class="text-left min-h-28 p-2 bg-[color:var(--bg-elevated)] border ui-border rounded hover:bg-[color:var(--bg-primary)] transition-colors ${ring}">
						<div class="text-xs font-semibold">${pad2(dayNum)}</div>
						<div class="mt-2 grid gap-1">${chips}${moreHtml}</div>
					</button>
				`;
			})
			.join('');

		rootEl.innerHTML = `
			<div class="grid grid-cols-7 gap-2">${headers}${cells}</div>
		`;
	}

	function renderWeekOrDayGrid(rootEl, rangeStart, daysCount, appts) {
		const startHour = 8;
		const endHour = 20;
		const totalMinutes = (endHour - startHour) * 60;
		const pxPerMinute = 1;
		const heightPx = totalMinutes * pxPerMinute;

		const dayDates = [];
		for (let i = 0; i < daysCount; i++) dayDates.push(addDays(rangeStart, i));

		const byDay = groupEventsByDay(appts);

		const headerCols = dayDates
			.map((d) => {
				const key = dateKeyLocal(d);
				const selected = selectedDayKey && selectedDayKey === key;
				const ring = selected ? 'ring-2 ring-gray-900 dark:ring-white' : '';
				return `<button type="button" data-cal-day="${key}" class="text-left px-2 py-2 text-xs font-semibold text-gray-700 dark:text-gray-200 border border-transparent rounded hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors ${ring}">${escapeHtml(formatShortDay(d))}</button>`;
			})
			.join('');

		const hours = [];
		for (let h = startHour; h <= endHour; h++) {
			hours.push(`<div class="h-[60px] text-xs text-gray-600 dark:text-gray-400 flex items-start justify-end pr-2 pt-1">${pad2(h)}:00</div>`);
		}

		const timeCol = `<div class="w-16">${hours.join('')}</div>`;

		const dayCols = dayDates
			.map((d) => {
				const key = dateKeyLocal(d);
				const items = (byDay.get(key) || []).filter((a) => a.status === 'booked');
				const lines = [];
				for (let m = 0; m <= totalMinutes; m += 60) {
					lines.push(`<div class="absolute left-0 right-0 border-t border-gray-200 dark:border-gray-800" style="top:${m * pxPerMinute}px"></div>`);
				}
				const laidOut = layoutDayItems(items, startHour, totalMinutes);
				const gapPx = 6;
				const events = laidOut
					.map((it) => {
						const a = it.a;
						const topMin = it.startMin;
						const bottomMin = it.endMin;
						const hPx = Math.max(18, (bottomMin - topMin) * pxPerMinute);
						const border = a.category === 'men' ? 'border-gray-900 dark:border-white' : 'border-gray-400 dark:border-gray-600';
						const title = buildEventTitle(a);
						const selected = selectedAppointmentId && selectedAppointmentId === a.id;
						const ring = selected ? 'ring-2 ring-gray-900 dark:ring-white' : '';

						const lanes = Math.max(1, it.lanes);
						const lane = clamp(it.lane, 0, lanes - 1);
						const widthCss = `calc((100% - ${(lanes - 1) * gapPx}px) / ${lanes})`;
						const leftCss = `calc(${lane} * ((100% - ${(lanes - 1) * gapPx}px) / ${lanes} + ${gapPx}px))`;

						return `
							<button type="button" data-cal-day="${key}" data-cal-appt="${escapeHtml(a.id)}" class="text-left absolute rounded border ${border} bg-gray-50 dark:bg-gray-900 px-2 py-1 overflow-hidden hover:bg-white dark:hover:bg-gray-950 transition-colors ${ring}" style="top:${topMin * pxPerMinute}px; height:${hPx}px; left:${leftCss}; width:${widthCss};">
								<div class="text-xs font-medium truncate">${escapeHtml(title)}</div>
							</button>
						`;
					})
					.join('');

				return `
					<div class="border border-gray-200 dark:border-gray-800 rounded overflow-hidden">
						<div class="relative" style="height:${heightPx}px">
							${lines.join('')}
							${events}
						</div>
					</div>
				`;
			})
			.join('');

		const gridCols = daysCount === 7 ? 'grid-cols-[64px_repeat(7,minmax(0,1fr))]' : 'grid-cols-[64px_minmax(0,1fr)]';

		rootEl.innerHTML = `
			<div class="grid ${gridCols} gap-2">
				<div></div>
				${headerCols}
				${timeCol}
				${dayCols}
			</div>
		`;
	}

	function renderDayDetails(dayKey) {
		if (!dayKey) {
			dayTitleEl.textContent = '';
			dayCountEl.textContent = '';
			dayDetailsEl.innerHTML = '<div class="text-sm text-gray-600 dark:text-gray-400">Bir gün seçin.</div>';
			return;
		}

		const dayDate = startOfLocalDay(dayKey);
		dayTitleEl.textContent = formatLongDay(dayDate);

		const items = getVisibleAppts()
			.filter((a) => apptDayKey(a) === dayKey)
			.slice()
			.sort((x, y) => (x.starts_at < y.starts_at ? -1 : 1));

		dayCountEl.textContent = `${items.length} randevu`;

		if (!items.length) {
			dayDetailsEl.innerHTML = '<div class="text-sm text-gray-600 dark:text-gray-400">Bu günde randevu yok.</div>';
			return;
		}

		dayDetailsEl.innerHTML = items
			.map((a) => {
				const services = Array.isArray(a.services) ? a.services.map((s) => s?.name).filter(Boolean).join(', ') : '';
				const badge = a.category === 'men'
					? '<span class="text-xs px-2 py-0.5 rounded border border-gray-900 dark:border-white">E</span>'
					: '<span class="text-xs px-2 py-0.5 rounded border border-gray-400 dark:border-gray-600">K</span>';
				const selected = selectedAppointmentId && selectedAppointmentId === a.id;
				const ring = selected ? 'ring-2 ring-gray-900 dark:ring-white' : '';
				const isEditing = editingAppointmentId && editingAppointmentId === a.id;
				const statusBadge = a.status && a.status !== 'booked'
					? `<span class="ml-2 text-xs px-2 py-0.5 rounded border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-200">${escapeHtml(a.status)}</span>`
					: '';
				return `
					<div id="appt-${escapeHtml(a.id)}" data-appt-card="${escapeHtml(a.id)}" class="rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-3 ${ring}">
						<div class="flex items-start justify-between gap-3">
							<div class="flex items-center gap-2">
								${badge}
								<div class="font-medium">${escapeHtml(formatTime(a.starts_at))} - ${escapeHtml(formatTime(a.ends_at))}${statusBadge}</div>
							</div>
							<div class="flex items-center gap-2">
								${a.status === 'booked' ? `<button type="button" data-appt-action="edit" data-appt-id="${escapeHtml(a.id)}" class="text-xs h-8 px-3 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">${isEditing ? 'Kapat' : 'Düzenle'}</button>` : ''}
								${a.status === 'booked' ? `<button type="button" data-appt-action="cancel" data-appt-id="${escapeHtml(a.id)}" class="text-xs h-8 px-3 rounded border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">İptal</button>` : ''}
							</div>
						</div>
						<div class="mt-2 text-sm text-gray-700 dark:text-gray-200">${escapeHtml(a.customer_full_name || '-')}</div>
						<div class="mt-1 text-xs text-gray-600 dark:text-gray-400">
							${a.staff_full_name ? `Personel: ${escapeHtml(a.staff_full_name)}` : 'Personel: -'}
						</div>
						${services ? `<div class="mt-1 text-xs text-gray-600 dark:text-gray-400">Hizmet: ${escapeHtml(services)}</div>` : ''}
						<div class="mt-1 text-xs text-gray-600 dark:text-gray-400">Telefon: ${escapeHtml(fmtPhone(a.customer_phone) || '-')}</div>
						${a.customer_email ? `<div class="mt-1 text-xs text-gray-600 dark:text-gray-400">E-posta: ${escapeHtml(a.customer_email)}</div>` : ''}
						${a.notes ? `<div class="mt-2 text-xs text-gray-600 dark:text-gray-400">Not: ${escapeHtml(a.notes)}</div>` : ''}
						${isEditing ? `
							<form class="mt-3 border-t border-gray-200 dark:border-gray-800 pt-3" data-appt-form="${escapeHtml(a.id)}">
								<div class="grid gap-2">
									<div class="grid grid-cols-2 gap-2">
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">Başlangıç</label>
											<input name="startTime" type="time" value="${escapeHtml(toTimeInputValue(a.starts_at))}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" required />
										</div>
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">Bitiş</label>
											<input name="endTime" type="time" value="${escapeHtml(toTimeInputValue(a.ends_at))}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" required />
										</div>
									</div>
									<div>
										<label class="text-xs text-gray-600 dark:text-gray-400">Personel</label>
										<select name="staffId" class="mt-1 w-full h-9 border border-gray-200 dark:border-gray-800 rounded px-2 bg-white dark:bg-gray-950">
											<option value="">-</option>
										</select>
									</div>
									<div class="grid grid-cols-2 gap-2">
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">Ad Soyad</label>
											<input name="customerFullName" type="text" value="${escapeHtml(a.customer_full_name || '')}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" required />
										</div>
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">Telefon</label>
											<input name="customerPhone" type="text" value="${escapeHtml(a.customer_phone || '')}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" required />
										</div>
									</div>
									<div class="grid grid-cols-2 gap-2">
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">E-posta</label>
											<input name="customerEmail" type="email" value="${escapeHtml(a.customer_email || '')}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" />
										</div>
										<div>
											<label class="text-xs text-gray-600 dark:text-gray-400">Not</label>
											<input name="notes" type="text" value="${escapeHtml(a.notes || '')}" class="mt-1 w-full border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-white dark:bg-gray-950" />
										</div>
									</div>
									<div class="flex items-center gap-2 mt-1">
										<button type="submit" class="h-9 px-4 rounded bg-gray-900 text-white dark:bg-white dark:text-gray-900 hover:bg-black dark:hover:bg-gray-200 transition-colors text-xs">Kaydet</button>
										<p class="text-xs text-gray-600 dark:text-gray-400" data-appt-form-status="${escapeHtml(a.id)}"></p>
									</div>
								</div>
							</form>
						` : ''}
					</div>
				`;
			})
			.join('');

		if (selectedAppointmentId) {
			const targetId = `appt-${selectedAppointmentId}`;
			// Wait for layout so scrollIntoView works reliably
			requestAnimationFrame(() => {
				const el = document.getElementById(targetId);
				if (el) el.scrollIntoView({ block: 'nearest' });
			});
		}
	}

	function computeCalendarRange() {
		let rangeStart;
		let rangeEnd;
		let label;

		if (calView === 'month') {
			const { year, month } = getIstanbulYMD(focusDate);
			const firstOfMonth = startOfLocalDay(`${year}-${pad2(month)}-01`);
			rangeStart = startOfWeek(firstOfMonth);
			rangeEnd = addDays(rangeStart, 42);
			label = focusDate.toLocaleDateString('tr-TR', { timeZone: IST_TZ, month: 'long', year: 'numeric' });
		} else if (calView === 'week') {
			rangeStart = startOfWeek(focusDate);
			rangeEnd = addDays(rangeStart, 7);
			label = `${formatDayLabel(rangeStart)} – ${formatDayLabel(addDays(rangeEnd, -1))}`;
		} else {
			rangeStart = startOfDay(focusDate);
			rangeEnd = endExclusiveOfDay(focusDate);
			label = formatDayLabel(focusDate);
		}

		return { rangeStart, rangeEnd, label };
	}

	function dayKeyInRange(dayKey, rangeStart, rangeEnd) {
		if (!dayKey) return false;
		const d = startOfLocalDay(dayKey);
		return d >= rangeStart && d < rangeEnd;
	}

	function renderCalendarFromCache() {
		const { rangeStart, rangeEnd, label } = computeCalendarRange();
		rangeLabel.textContent = label;

		if (!selectedDayKey || !dayKeyInRange(selectedDayKey, rangeStart, rangeEnd)) {
			selectedDayKey = dateKeyLocal(focusDate);
			selectedAppointmentId = null;
		}

		const visible = getVisibleAppts();
		if (calView === 'month') {
			renderMonth(gridEl, rangeStart, visible);
		} else if (calView === 'week') {
			renderWeekOrDayGrid(gridEl, rangeStart, 7, visible);
		} else {
			renderWeekOrDayGrid(gridEl, rangeStart, 1, visible);
		}

		renderDayDetails(selectedDayKey);
	}

	async function fetchAppointments(startIso, endIso, opts = {}) {
		const url = new URL(`${apiBasePath}/appointments`, window.location.origin);
		url.searchParams.set('start', startIso);
		url.searchParams.set('end', endIso);
		if (opts.category) url.searchParams.set('category', String(opts.category));
		if (opts.staffId) url.searchParams.set('staffId', String(opts.staffId));
		if (opts.includePast) url.searchParams.set('includePast', '1');
		const resp = await fetch(url.toString(), {
			headers: { 'Accept': 'application/json' },
			credentials: 'same-origin',
		});
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const data = await resp.json();
		return Array.isArray(data.appointments) ? data.appointments : [];
	}

	async function loadList() {
		const startDate = startInput.value;
		const endDate = endInput.value;
		if (!startDate || !endDate) return;

		const start = startOfLocalDay(startDate);
		// Treat end as inclusive in UI; send end-exclusive to API by adding 1 day.
		const endExclusive = addDays(startOfLocalDay(endDate), 1);

		statusEl.textContent = 'Yükleniyor…';
		menEl.innerHTML = '';
		womenEl.innerHTML = '';

		try {
			const appts = await fetchAppointments(start.toISOString(), endExclusive.toISOString(), {
				includePast: true,
				staffId: staffId && staffId !== 'all' ? staffId : null,
			});

			const men = appts.filter((a) => a.category === 'men');
			const women = appts.filter((a) => a.category === 'women');

			renderList(menEl, men);
			renderList(womenEl, women);
			statusEl.textContent = `${appts.length} randevu`;
		} catch (e) {
			console.error(e);
			statusEl.textContent = 'Yükleme hatası';
			menEl.innerHTML = '<div class="text-sm text-red-700 dark:text-red-300">Randevular getirilemedi.</div>';
			womenEl.innerHTML = '<div class="text-sm text-red-700 dark:text-red-300">Randevular getirilemedi.</div>';
		}
	}

	async function hydrateStaffSelectFor(apptId, category, selectedStaffId) {
		const form = dayDetailsEl.querySelector(`[data-appt-form="${cssEscape(apptId)}"]`);
		if (!form) return;
		const select = form.querySelector('select[name="staffId"]');
		if (!(select instanceof HTMLSelectElement)) return;
		const staff = await fetchStaff(category);
		const options = staff
			.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || '-')}${s.category === 'both' ? ' (her ikisi)' : ''}</option>`)
			.join('');
		select.innerHTML = `<option value="">-</option>${options}`;
		if (selectedStaffId) select.value = selectedStaffId;
	}

	async function submitAppointmentUpdate(apptId, dayKey, form) {
		const statusEl = dayDetailsEl.querySelector(`[data-appt-form-status="${cssEscape(apptId)}"]`);
		if (statusEl) statusEl.textContent = 'Kaydediliyor…';

		const fd = new FormData(form);
		const startTime = String(fd.get('startTime') || '');
		const endTime = String(fd.get('endTime') || '');
		const starts = timeOnDay(dayKey, startTime);
		const ends = timeOnDay(dayKey, endTime);
		if (!starts || !ends || ends <= starts) {
			if (statusEl) statusEl.textContent = 'Saat aralığı geçersiz.';
			return;
		}

		const payload = {
			staffId: String(fd.get('staffId') || '') || null,
			startsAt: starts.toISOString(),
			endsAt: ends.toISOString(),
			customerFullName: String(fd.get('customerFullName') || '').trim(),
			customerPhone: String(fd.get('customerPhone') || '').trim(),
			customerEmail: String(fd.get('customerEmail') || '').trim() || null,
			notes: String(fd.get('notes') || '').trim() || null,
		};

		try {
			const resp = await fetch(`${apiBasePath}/appointments/${encodeURIComponent(apptId)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(payload),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				throw new Error(data?.message || `HTTP ${resp.status}`);
			}
			if (statusEl) statusEl.textContent = 'Kaydedildi.';
			editingAppointmentId = null;
			await loadCalendar();
		} catch (err) {
			if (statusEl) statusEl.textContent = err?.message || 'Kaydetme hatası.';
		}
	}

	async function cancelAppointmentById(apptId) {
		if (!window.confirm('Randevu iptal edilsin mi?')) return;
		const reasonRaw = window.prompt('İptal nedeni (isteğe bağlı):', '')
			?? '';
		const reason = String(reasonRaw).trim();
		try {
			const resp = await fetch(`${apiBasePath}/appointments/${encodeURIComponent(apptId)}`, {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ reason: reason || null }),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				throw new Error(data?.message || `HTTP ${resp.status}`);
			}
			editingAppointmentId = null;
			selectedAppointmentId = null;
			await loadCalendar();
		} catch (err) {
			window.alert(err?.message || 'İptal hatası');
		}
	}

	async function loadCalendar() {
		gridEl.innerHTML = '';
		rangeLabel.textContent = 'Yükleniyor…';

		const { rangeStart, rangeEnd } = computeCalendarRange();

		try {
			const appts = await fetchAppointments(rangeStart.toISOString(), rangeEnd.toISOString(), {
				includePast: false,
				category: (branch === 'men' || branch === 'women') ? branch : null,
				staffId: staffId && staffId !== 'all' ? staffId : null,
			});
			lastCalendarApptsRaw = appts;
			// When range changes, keep selection sane
			if (!selectedDayKey || !dayKeyInRange(selectedDayKey, rangeStart, rangeEnd)) {
				selectedDayKey = dateKeyLocal(focusDate);
			}
			selectedAppointmentId = null;
			editingAppointmentId = null;

			renderCalendarFromCache();
		} catch (e) {
			console.error(e);
			gridEl.innerHTML = '<div class="text-sm text-red-700 dark:text-red-300">Takvim yüklenemedi.</div>';
			rangeLabel.textContent = 'Yükleme hatası';
			dayDetailsEl.innerHTML = '<div class="text-sm text-red-700 dark:text-red-300">Gün detayı yüklenemedi.</div>';
		}
	}

	function setMode(nextMode) {
		mode = nextMode;
		const listActive = mode === 'list';
		listWrap.classList.toggle('hidden', !listActive);
		calWrap.classList.toggle('hidden', listActive);
		listControls.classList.toggle('hidden', !listActive);
		calControls.classList.toggle('hidden', listActive);

		modeListBtn.className =
			'h-10 rounded px-3 border border-gray-200 dark:border-gray-800 ' +
			(listActive
				? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
				: 'bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors');
		modeCalBtn.className =
			'h-10 rounded px-3 border border-gray-200 dark:border-gray-800 ' +
			(!listActive
				? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
				: 'bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors');

		void loadStaffOptions();

		if (listActive) loadList();
		else loadCalendar();
	}

	function shiftFocus(direction) {
		if (calView === 'month') {
			const { year, month } = getIstanbulYMD(focusDate);
			// Move by month in a timezone-stable way using calendar components.
			const shiftedUtc = new Date(Date.UTC(year, (month - 1) + direction, 1));
			const { year: y2, month: m2 } = getIstanbulYMD(shiftedUtc);
			focusDate = startOfLocalDay(`${y2}-${pad2(m2)}-01`);
		} else if (calView === 'week') {
			focusDate = addDays(focusDate, direction * 7);
		} else {
			focusDate = addDays(focusDate, direction);
		}
		focusInput.value = toDateInputValue(focusDate);
		selectedDayKey = dateKeyLocal(focusDate);
		selectedAppointmentId = null;
		loadCalendar();
	}

	// Defaults: today -> today+7 (Turkey time)
	const todayKey = dateKeyLocal(new Date());
	const today = startOfLocalDay(todayKey);
	startInput.value = toDateInputValue(today);
	endInput.value = toDateInputValue(addDays(today, 7));
	focusDate = today;
	focusInput.value = toDateInputValue(focusDate);
	viewSelect.value = 'month';
	calView = 'month';
	branchSelect.value = 'all';
	branch = 'all';

	loadBtn.addEventListener('click', () => loadList());
	modeListBtn.addEventListener('click', () => setMode('list'));
	modeCalBtn.addEventListener('click', () => setMode('calendar'));
	viewSelect.addEventListener('change', () => {
		calView = viewSelect.value;
		selectedDayKey = dateKeyLocal(focusDate);
		selectedAppointmentId = null;
		loadCalendar();
	});
	branchSelect.addEventListener('change', () => {
		branch = branchSelect.value;
		selectedAppointmentId = null;
		void loadStaffOptions();
		loadCalendar();
	});
	staffSelect.addEventListener('change', () => {
		staffId = staffSelect.value;
		selectedAppointmentId = null;
		selectedDayKey = dateKeyLocal(focusDate);
		if (mode === 'list') void loadList();
		else void loadCalendar();
	});
	focusInput.addEventListener('change', () => {
		if (!focusInput.value) return;
		focusDate = startOfLocalDay(focusInput.value);
		selectedDayKey = dateKeyLocal(focusDate);
		selectedAppointmentId = null;
		loadCalendar();
	});
	prevBtn.addEventListener('click', () => shiftFocus(-1));
	nextBtn.addEventListener('click', () => shiftFocus(1));
	todayBtn.addEventListener('click', () => {
		focusDate = startOfLocalDay(dateKeyLocal(new Date()));
		focusInput.value = toDateInputValue(focusDate);
		selectedDayKey = dateKeyLocal(focusDate);
		selectedAppointmentId = null;
		loadCalendar();
	});

	gridEl.addEventListener('click', (ev) => {
		const t = ev.target;
		if (!(t instanceof HTMLElement)) return;
		const apptBtn = t.closest('[data-cal-appt]');
		if (apptBtn) {
			const day = apptBtn.getAttribute('data-cal-day');
			const apptId = apptBtn.getAttribute('data-cal-appt');
			if (day) {
				selectedDayKey = day;
				selectedAppointmentId = apptId;
				renderCalendarFromCache();
				return;
			}
		}

		const dayBtn = t.closest('[data-cal-day]');
		if (dayBtn) {
			const day = dayBtn.getAttribute('data-cal-day');
			if (!day) return;
			selectedDayKey = day;
			selectedAppointmentId = null;
			renderCalendarFromCache();
		}
	});

	dayDetailsEl.addEventListener('click', async (ev) => {
		const t = ev.target;
		if (!(t instanceof HTMLElement)) return;

		// Don't let generic card click handling interfere with form interactions.
		// Otherwise selects/inputs become effectively unclickable due to rerender.
		if (t.closest('form')) return;

		const actionBtn = t.closest('[data-appt-action]');
		if (actionBtn) {
			const action = actionBtn.getAttribute('data-appt-action');
			const apptId = actionBtn.getAttribute('data-appt-id');
			if (!apptId) return;
			const appt = getVisibleAppts().find((a) => a.id === apptId);
			if (!appt) return;

			if (action === 'edit') {
				editingAppointmentId = editingAppointmentId === apptId ? null : apptId;
				selectedAppointmentId = apptId;
				renderCalendarFromCache();
				if (editingAppointmentId) {
					try {
						await hydrateStaffSelectFor(apptId, appt.category, appt.staff_id);
					} catch (e) {
						console.error(e);
					}
				}
				return;
			}

			if (action === 'cancel') {
				await cancelAppointmentById(apptId);
				return;
			}
		}

		const card = t.closest('[data-appt-card]');
		if (card) {
			const apptId = card.getAttribute('data-appt-card');
			if (apptId) {
				selectedAppointmentId = apptId;
				renderCalendarFromCache();
			}
		}
	});

	dayDetailsEl.addEventListener('submit', async (ev) => {
		const form = ev.target;
		if (!(form instanceof HTMLFormElement)) return;
		const apptId = form.getAttribute('data-appt-form');
		if (!apptId) return;
		ev.preventDefault();
		await submitAppointmentUpdate(apptId, selectedDayKey, form);
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

	function refreshCurrentView() {
		if (mode === 'list') {
			void loadList();
			return;
		}
		void loadCalendar();
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
			refreshCurrentView();
		});

		socket.on('updateAppointment', () => {
			refreshCurrentView();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', bindRealtime);
	} else {
		bindRealtime();
	}

	setMode('list');
})();
