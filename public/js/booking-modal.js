// Booking Modal Wizard (3-step) - Vanilla JS, category-aware
(() => {
	const modalBackdrop = document.getElementById('bookingModalBackdrop');
	if (!modalBackdrop) return;

	const APPOINTMENT_DURATION_MINUTES = 40;

	const modalPanel = document.getElementById('bookingModalPanel');
	const closeButtons = Array.from(document.querySelectorAll('[data-booking-close]'));
	const openTriggers = Array.from(document.querySelectorAll('[data-book-trigger]'));

	const stepEls = {
		1: document.getElementById('bmStep1'),
		2: document.getElementById('bmStep2'),
		3: document.getElementById('bmStep3'),
	};

	const stepDots = Array.from(document.querySelectorAll('[data-bm-step-dot]'));

	const servicesWrap = document.getElementById('bmServices');
	const staffSelect = document.getElementById('bmStaff');
	const dateInput = document.getElementById('bmDate');
	const slotsWrap = document.getElementById('bmSlots');
	const next1 = document.getElementById('bmNext1');
	const back2 = document.getElementById('bmBack2');
	const next2 = document.getElementById('bmNext2');
	const back3 = document.getElementById('bmBack3');
	const checkBtn = document.getElementById('bmCheck');
	const submitBtn = document.getElementById('bmSubmit');
	const statusBox = document.getElementById('bmStatus');

	const fullNameInput = document.getElementById('bmName');
	const phoneInput = document.getElementById('bmPhone');
	const emailInput = document.getElementById('bmEmail');
	const notesInput = document.getElementById('bmNotes');

	const apiBase = '/booking';

	let activeStep = 1;
	let selectedCategory = 'men';
	let selectedService = null; // {id, duration_minutes, price_cents, name}
	let selectedStaffId = '';
	let selectedSlot = null; // {startsAt, endsAt}

	function getCategory() {
		const c = document.documentElement.getAttribute('data-category');
		return c === 'women' ? 'women' : 'men';
	}

	function setStatus(text, kind = 'info') {
		if (!statusBox) return;
		statusBox.textContent = text || '';
		statusBox.className =
			'rounded-lg border ui-border px-3 py-2 text-sm ' +
			(kind === 'error'
				? 'bg-[color:var(--bg-elevated)] text-red-700'
				: kind === 'success'
				? 'bg-[color:var(--bg-elevated)] text-emerald-700'
				: 'bg-[color:var(--bg-elevated)] ui-muted');
		if (!text) statusBox.className = 'hidden';
		else statusBox.classList.remove('hidden');
	}

	function setStep(n) {
		activeStep = n;
		Object.entries(stepEls).forEach(([k, el]) => {
			if (!el) return;
			el.classList.toggle('hidden', Number(k) !== n);
		});
		stepDots.forEach((d) => {
			const dn = Number(d.getAttribute('data-bm-step-dot'));
			d.classList.toggle('bg-[color:var(--accent)]', dn === n);
			d.classList.toggle('bg-[color:var(--border)]', dn !== n);
		});
	}

	function lockBody(lock) {
		document.body.style.overflow = lock ? 'hidden' : '';
	}

	function openModal() {
		modalBackdrop.setAttribute('aria-hidden', 'false');
		lockBody(true);
		modalPanel && modalPanel.focus && modalPanel.focus();
	}

	function closeModal() {
		modalBackdrop.setAttribute('aria-hidden', 'true');
		lockBody(false);
		setStatus('');
	}

	function moneyTL(priceCents) {
		const v = Number(priceCents || 0) / 100;
		return v.toFixed(2) + ' TL';
	}

	function formatTime(iso) {
		return new Date(iso).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
	}

	async function fetchJson(url) {
		const res = await fetch(url, { credentials: 'include' });
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	function resetWizard() {
		selectedCategory = getCategory();
		selectedService = null;
		selectedStaffId = '';
		selectedSlot = null;
		servicesWrap.innerHTML = '';
		slotsWrap.innerHTML = '';
		dateInput.value = '';
		staffSelect.innerHTML = '<option value="">Otomatik ata</option>';
		fullNameInput.value = '';
		phoneInput.value = '';
		emailInput.value = '';
		notesInput.value = '';
		next1.disabled = true;
		next2.disabled = true;
		submitBtn.disabled = true;
		setStatus('');
		setStep(1);
	}

	async function loadServices() {
		servicesWrap.innerHTML = '';
		const data = await fetchJson(`${apiBase}/api/services?category=${encodeURIComponent(selectedCategory)}`);

		for (const svc of data.services) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className =
				'w-full ui-card rounded-xl px-4 py-3 text-left hover:opacity-95 transition-colors border ui-border';

			btn.innerHTML = `
				<div class="flex items-baseline gap-3">
					<div class="flex-1">
						<p class="font-semibold">${svc.name}</p>
						<p class="text-xs ui-muted mt-1">Randevu süresi: ${APPOINTMENT_DURATION_MINUTES} dk</p>
					</div>
					<div class="text-sm font-semibold ui-accent">${moneyTL(svc.price_cents)}</div>
				</div>
			`;

			btn.addEventListener('click', () => {
				selectedService = svc;
				Array.from(servicesWrap.querySelectorAll('button')).forEach((b) => {
					b.classList.remove('ring-2');
					b.style.boxShadow = '';
				});
				btn.classList.add('ring-2');
				btn.style.boxShadow = `0 0 0 4px var(--ring)`;
				next1.disabled = false;
				next2.disabled = false;
				slotsWrap.innerHTML = '';
				selectedSlot = null;
				submitBtn.disabled = true;
				setStatus('');
			});

			servicesWrap.appendChild(btn);
		}

		if (!data.services.length) {
			servicesWrap.innerHTML = '<p class="ui-muted text-sm">Bu kategori için aktif hizmet bulunamadı.</p>';
		}
	}

	async function loadStaff() {
		staffSelect.innerHTML = '<option value="">Otomatik ata</option>';
		const data = await fetchJson(`${apiBase}/api/staff?category=${encodeURIComponent(selectedCategory)}`);
		for (const p of data.staff) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.full_name;
			staffSelect.appendChild(opt);
		}
	}

	async function checkAvailability() {
		if (!selectedService) return setStatus('Lütfen hizmet seçin.', 'error');
		if (!dateInput.value) return setStatus('Lütfen tarih seçin.', 'error');

		setStatus('Müsait saatler alınıyor...');
		slotsWrap.innerHTML = '';
		selectedSlot = null;
		submitBtn.disabled = true;

		const qs = new URLSearchParams({
			category: selectedCategory,
			date: dateInput.value,
			durationMinutes: String(APPOINTMENT_DURATION_MINUTES),
		});
		if (selectedStaffId) qs.set('staffId', selectedStaffId);

		const data = await fetchJson(`${apiBase}/api/availability?${qs.toString()}`);
		const available = (data.slots || []).filter((s) => s.available);

		if (!available.length) {
			setStatus('Seçilen tarihte uygun saat bulunamadı.', 'error');
			return;
		}

		available.forEach((slot) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'ui-btn ui-btn-ghost w-full justify-start';
			b.textContent = `${formatTime(slot.startsAt)} - ${formatTime(slot.endsAt)}`;
			b.addEventListener('click', () => {
				selectedSlot = slot;
				Array.from(slotsWrap.querySelectorAll('button')).forEach((x) => x.classList.remove('ui-btn-primary'));
				b.classList.add('ui-btn-primary');
				submitBtn.disabled = false;
				setStatus('');
			});
			slotsWrap.appendChild(b);
		});

		setStatus('Uygun saat seçin.');
	}

	async function submitBooking() {
		if (!selectedService) return setStatus('Lütfen hizmet seçin.', 'error');
		if (!selectedSlot) return setStatus('Lütfen saat seçin.', 'error');
		if (!String(fullNameInput.value || '').trim()) return setStatus('Ad Soyad zorunludur.', 'error');
		if (!String(phoneInput.value || '').trim()) return setStatus('Telefon zorunludur.', 'error');

		setStatus('Randevu oluşturuluyor...');

		const payload = {
			category: selectedCategory,
			serviceIds: [selectedService.id],
			staffId: selectedStaffId || null,
			startsAt: selectedSlot.startsAt,
			endsAt: selectedSlot.endsAt,
			customerFullName: String(fullNameInput.value || '').trim(),
			customerPhone: String(phoneInput.value || '').trim(),
			customerEmail: String(emailInput.value || '').trim() || null,
			notes: String(notesInput.value || '').trim() || null,
		};

		const res = await fetch(`${apiBase}/api`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(payload),
		});

		if (res.status === 409) {
			const data = await res.json().catch(() => null);
			return setStatus((data && data.message) || 'Seçilen saat dolu. Lütfen başka saat seçin.', 'error');
		}
		if (!res.ok) return setStatus('Randevu oluşturulamadı.', 'error');

		const data = await res.json();
		setStatus(`Randevunuz alındı. Kod: ${data.appointmentId}`, 'success');
	}

	// Bind events
	openTriggers.forEach((a) => {
		a.addEventListener('click', async (e) => {
			// If we are on a page without the modal UI, allow normal navigation.
			if (!modalBackdrop) return;
			e.preventDefault();
			resetWizard();
			openModal();
			try {
				await loadServices();
				await loadStaff();
			} catch {
				setStatus('Veriler yüklenirken hata oluştu.', 'error');
			}
		});
	});

	closeButtons.forEach((b) => b.addEventListener('click', closeModal));

	modalBackdrop.addEventListener('click', (e) => {
		if (e.target === modalBackdrop) return closeModal();
		if (e.target && e.target.matches && e.target.matches('[data-booking-overlay]')) return closeModal();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && modalBackdrop.getAttribute('aria-hidden') === 'false') closeModal();
	});

	staffSelect.addEventListener('change', () => {
		selectedStaffId = staffSelect.value;
		slotsWrap.innerHTML = '';
		selectedSlot = null;
		submitBtn.disabled = true;
	});

	dateInput.addEventListener('change', () => {
		slotsWrap.innerHTML = '';
		selectedSlot = null;
		submitBtn.disabled = true;
	});

	next1.addEventListener('click', () => {
		if (!selectedService) return;
		setStep(2);
	});

	back2.addEventListener('click', () => setStep(1));

	next2.addEventListener('click', () => setStep(3));

	back3.addEventListener('click', () => setStep(2));

	checkBtn.addEventListener('click', () => {
		checkAvailability().catch(() => setStatus('Saatler alınırken hata oluştu.', 'error'));
	});

	submitBtn.addEventListener('click', () => {
		submitBooking().catch(() => setStatus('Randevu oluşturulurken hata oluştu.', 'error'));
	});

	// If theme changes while modal is open, refresh content.
	document.addEventListener('category:changed', async (ev) => {
		if (modalBackdrop.getAttribute('aria-hidden') !== 'false') return;
		selectedCategory = ev && ev.detail && ev.detail.category ? ev.detail.category : getCategory();
		selectedService = null;
		selectedSlot = null;
		next1.disabled = true;
		submitBtn.disabled = true;
		try {
			await loadServices();
			await loadStaff();
		} catch {
			setStatus('Veriler yenilenirken hata oluştu.', 'error');
		}
	});
})();
