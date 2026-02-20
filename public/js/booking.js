// Booking wizard - Vanilla JS
(async () => {
	const wizard = document.getElementById('bookingWizard');
	if (!wizard) return;

	const APPOINTMENT_DURATION_MINUTES = 40;

	const apiBase = (wizard.dataset.apiBase || '/booking').replace(/\/$/, '');
	const presetCategory = (wizard.dataset.presetCategory || '').trim();

	let selectedCategory = null;
	let selectedServiceIds = new Set();
	let selectedStaffId = '';
	let selectedSlot = null;

	const categoryHint = document.getElementById('categoryHint');
	const servicesList = document.getElementById('servicesList');
	const staffSelect = document.getElementById('staffSelect');
	const dateInput = document.getElementById('dateInput');
	const durationHint = document.getElementById('durationHint');
	const loadSlotsBtn = document.getElementById('loadSlotsBtn');
	const slotsList = document.getElementById('slotsList');
	const confirmBtn = document.getElementById('confirmBtn');
	const resultBox = document.getElementById('resultBox');
	const slotsMsg = document.getElementById('slotsMsg');

	const fullNameInput = document.getElementById('fullNameInput');
	const phoneInput = document.getElementById('phoneInput');
	const emailInput = document.getElementById('emailInput');
	const notesInput = document.getElementById('notesInput');

	let loadedSlotParamsKey = '';

	function setResult(text, kind = 'info') {
		resultBox.textContent = text;
		resultBox.className = 'mt-3 text-sm ' + (kind === 'error' ? 'text-red-700' : kind === 'success' ? 'text-emerald-700' : 'text-gray-700');
	}

	function setSlotsResult(text, kind = 'info') {
		if (!slotsMsg) return;
		slotsMsg.textContent = text;
		slotsMsg.className = 'mt-2 text-sm ' + (kind === 'error' ? 'text-red-700' : kind === 'success' ? 'text-emerald-700' : 'text-gray-700');
	}

	function formatTime(iso) {
		return new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
	}

	function updateDurationHint() {
		if (!durationHint) return;
		durationHint.textContent = `Randevu süresi standart ${APPOINTMENT_DURATION_MINUTES} dakikadır (seçtiğiniz hizmetlerden bağımsız).`;
		durationHint.className = 'mt-2 text-xs ui-muted';
	}

	function currentSlotsKey() {
		const staff = String(selectedStaffId || '');
		const dt = String(dateInput.value || '');
		const svcs = Array.from(selectedServiceIds).sort().join(',');
		return `${selectedCategory}|${dt}|${staff}|${svcs}`;
	}

	function invalidateSlots(reasonText = 'Seçimler değişti. Lütfen müsait saatleri yeniden getirip saat seçin.') {
		selectedSlot = null;
		slotsList.innerHTML = '';
		loadedSlotParamsKey = '';
		if (reasonText) setSlotsResult(reasonText, 'info');
	}

	function setActiveCategoryButton(activeBtn) {
		if (!activeBtn) return;
		wizard.querySelectorAll('button[data-category]').forEach((btn) => {
			btn.classList.remove('bg-gray-900', 'text-white', 'dark:bg-white', 'dark:text-gray-900');
			btn.setAttribute('aria-pressed', 'false');
		});
		activeBtn.classList.add('bg-gray-900', 'text-white', 'dark:bg-white', 'dark:text-gray-900');
		activeBtn.setAttribute('aria-pressed', 'true');
	}

	async function fetchJson(url) {
		const res = await fetch(url, { credentials: 'include' });
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	async function loadServicesAndStaff() {
		servicesList.innerHTML = '';
		staffSelect.innerHTML = '<option value="">Otomatik ata</option>';
		selectedServiceIds = new Set();
		selectedStaffId = '';
		selectedSlot = null;
		slotsList.innerHTML = '';

		const services = await fetchJson(`${apiBase}/api/services?category=${encodeURIComponent(selectedCategory)}`);
		for (const svc of services.services) {
			const row = document.createElement('label');
			row.className = 'flex items-center gap-3 border ui-border rounded px-3 py-2 bg-[color:var(--bg-elevated)] hover:opacity-95 transition-colors';
			row.innerHTML = `
				<input type="checkbox" value="${svc.id}" />
				<span class="flex-1">${svc.name}</span>
				<span class="font-medium">${(svc.price_cents/100).toFixed(2)} TL</span>
			`;
			const input = row.querySelector('input');
			input.addEventListener('change', (e) => {
				if (e.target.checked) {
					selectedServiceIds.add(svc.id);
					row.classList.add('ring-2');
					row.style.boxShadow = `0 0 0 4px var(--ring)`;
				} else {
					selectedServiceIds.delete(svc.id);
					row.classList.remove('ring-2');
					row.style.boxShadow = '';
				}
				updateDurationHint();
				invalidateSlots();
			});
			servicesList.appendChild(row);
		}

		const staff = await fetchJson(`${apiBase}/api/staff?category=${encodeURIComponent(selectedCategory)}`);
		for (const p of staff.staff) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.full_name;
			staffSelect.appendChild(opt);
		}

		updateDurationHint();
	}

	wizard.querySelectorAll('button[data-category]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			selectedCategory = btn.getAttribute('data-category');
			setActiveCategoryButton(btn);
			categoryHint.textContent = selectedCategory === 'men' ? 'Erkek Kuaförü için seçtiniz.' : 'Güzellik Salonu için seçtiniz.';
			setResult('');
			setSlotsResult('');
			await loadServicesAndStaff();
		});
	});

	if (presetCategory) {
		selectedCategory = presetCategory;
		categoryHint.textContent = selectedCategory === 'men' ? 'Erkek Kuaförü için randevu alıyorsunuz.' : 'Güzellik Salonu için randevu alıyorsunuz.';
		try {
			await loadServicesAndStaff();
		} catch {
			setSlotsResult('Hizmetler yüklenirken hata oluştu.', 'error');
		}
	}

	staffSelect.addEventListener('change', () => {
		selectedStaffId = staffSelect.value;
		invalidateSlots();
	});

	dateInput.addEventListener('change', () => {
		invalidateSlots();
	});

	loadSlotsBtn.addEventListener('click', async () => {
		try {
			setSlotsResult('Müsait saatler alınıyor...');
			selectedSlot = null;
			slotsList.innerHTML = '';

			if (!selectedCategory) return setSlotsResult('Lütfen önce kategori seçin.', 'error');
			if (selectedServiceIds.size === 0) return setSlotsResult('Lütfen en az bir hizmet seçin.', 'error');
			if (!dateInput.value) return setSlotsResult('Lütfen tarih seçin.', 'error');

			const qs = new URLSearchParams({
				category: selectedCategory,
				date: dateInput.value,
			});
			if (selectedStaffId) qs.set('staffId', selectedStaffId);

			const data = await fetchJson(`${apiBase}/api/availability?${qs.toString()}`);
			const availableSlots = data.slots.filter((s) => s.available);

			if (availableSlots.length === 0) {
				if (data && data.closed) {
					setSlotsResult(data.message || 'Seçilen gün kapalı.', 'error');
				} else {
					setSlotsResult('Seçilen tarihte uygun saat bulunamadı.', 'error');
				}
				return;
			}

			loadedSlotParamsKey = currentSlotsKey();

			for (const slot of availableSlots) {
				const b = document.createElement('button');
				b.type = 'button';
				b.className = 'border ui-border rounded px-3 py-2 text-left bg-[color:var(--bg-elevated)] hover:opacity-95 transition-colors';
				b.textContent = `${formatTime(slot.startsAt)} - ${formatTime(slot.endsAt)}`;
				b.addEventListener('click', () => {
					selectedSlot = slot;
					Array.from(slotsList.querySelectorAll('button')).forEach((x) => {
						x.classList.remove('ui-btn-primary');
						x.style.background = '';
						x.style.color = '';
					});
					b.style.background = 'var(--accent)';
					b.style.color = 'var(--accent-contrast)';
				});
				slotsList.appendChild(b);
			}

			setSlotsResult('Uygun saat seçin.');
			setResult('');
		} catch {
			setSlotsResult('Saatler alınırken hata oluştu.', 'error');
		}
	});

	confirmBtn.addEventListener('click', async () => {
		try {
			if (!selectedCategory) return setResult('Lütfen kategori seçin.', 'error');
			if (selectedServiceIds.size === 0) return setResult('Lütfen hizmet seçin.', 'error');
			if (!selectedSlot) return setResult('Lütfen saat seçin.', 'error');
			if (!fullNameInput.value.trim()) return setResult('Ad Soyad zorunludur.', 'error');
			if (!phoneInput.value.trim()) return setResult('Telefon zorunludur.', 'error');

			// Prevent accidental mismatches (e.g. slots loaded for 30dk but user switched to 60dk).
			const currentKey = currentSlotsKey();
			if (!loadedSlotParamsKey || loadedSlotParamsKey !== currentKey) {
				return setResult('Seçimler değişti. Lütfen “Müsait Saatleri Getir” ile saatleri yeniden yükleyip tekrar saat seçin.', 'error');
			}

			setResult('Randevu oluşturuluyor...');

			const payload = {
				category: selectedCategory,
				serviceIds: Array.from(selectedServiceIds),
				staffId: selectedStaffId || null,
				startsAt: selectedSlot.startsAt,
				endsAt: selectedSlot.endsAt,
				customerFullName: fullNameInput.value.trim(),
				customerPhone: phoneInput.value.trim(),
				customerEmail: emailInput.value.trim() || null,
				notes: notesInput.value.trim() || null,
			};

			const res = await fetch(`${apiBase}/api`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(payload),
			});

			if (res.status === 409) {
				const data = await res.json();
				return setResult(data.message || 'Saat dolu.', 'error');
			}

			if (!res.ok) {
				return setResult('Randevu oluşturulamadı.', 'error');
			}

			const data = await res.json();
			setResult(
				`Randevunuz alındı. Kod: ${data.appointmentId} — Lütfen bu kodu kopyalayın veya not alın. Herhangi bir sorun olursa bizimle iletişime geçerken bu kodu paylaşın.`,
				'success'
			);
		} catch {
			setResult('Randevu oluşturulurken hata oluştu.', 'error');
		}
	});
})();
