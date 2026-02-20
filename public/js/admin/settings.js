// Admin settings - manage services & staff
(async () => {
	const adminBasePath = (typeof window.__ADMIN_BASE_PATH__ === 'string') ? window.__ADMIN_BASE_PATH__ : '';
	const apiBase = adminBasePath ? `${adminBasePath}/api` : '/api';

	const addServiceBtn = document.getElementById('addServiceBtn');
	const addStaffBtn = document.getElementById('addStaffBtn');
	const saveHoursMen = document.getElementById('saveHoursMen');
	const saveHoursWomen = document.getElementById('saveHoursWomen');
	const addOverrideMen = document.getElementById('addOverrideMen');
	const addOverrideWomen = document.getElementById('addOverrideWomen');
	const saveContactMen = document.getElementById('saveContactMen');
	const saveContactWomen = document.getElementById('saveContactWomen');
	const deleteOverrideButtons = Array.from(document.querySelectorAll('.deleteOverride'));
	if (!addServiceBtn && !addStaffBtn && !saveHoursMen && !saveHoursWomen && !addOverrideMen && !addOverrideWomen && !saveContactMen && !saveContactWomen && deleteOverrideButtons.length === 0) return;

	async function postJson(url, body) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	async function putJson(url, body) {
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	async function deleteJson(url) {
		const res = await fetch(url, {
			method: 'DELETE',
			credentials: 'include',
		});
		if (!res.ok) throw new Error('Request failed');
		return res.json();
	}

	addServiceBtn?.addEventListener('click', async () => {
		const msg = document.getElementById('serviceMsg');
		try {
			msg.textContent = 'Kaydediliyor...';
			const priceTl = Number(document.getElementById('svcPrice').value);
			const priceCents = Number.isFinite(priceTl) ? Math.round(priceTl * 100) : 0;
			const editingId = addServiceBtn.dataset.editingId || null;
			const payload = {
				name: document.getElementById('svcName').value,
				durationMinutes: Number(document.getElementById('svcDuration').value),
				priceCents,
				category: document.getElementById('svcCategory').value,
			};
			if (editingId) payload.id = editingId;
			await postJson(`${apiBase}/services`, payload);
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = editingId ? 'Hizmet güncellendi. Sayfa yenileniyor...' : 'Hizmet eklendi. Sayfa yenileniyor...';
			setTimeout(() => window.location.reload(), 300);
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası.';
		}
	});

	addStaffBtn?.addEventListener('click', async () => {
		const msg = document.getElementById('staffMsg');
		try {
			msg.textContent = 'Kaydediliyor...';
			const editingId = addStaffBtn.dataset.editingId || null;
			const payload = {
				fullName: document.getElementById('staffName').value,
				category: document.getElementById('staffCategory').value,
				googleCalendarId: document.getElementById('staffCalendarId').value || null,
			};
			if (editingId) {
				await putJson(`${apiBase}/staff/${editingId}`, payload);
			} else {
				await postJson(`${apiBase}/staff`, payload);
			}
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = editingId ? 'Personel güncellendi. Sayfa yenileniyor...' : 'Personel eklendi. Sayfa yenileniyor...';
			setTimeout(() => window.location.reload(), 300);
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası.';
		}
	});

	Array.from(document.querySelectorAll('.editService')).forEach((btn) => {
		btn.addEventListener('click', () => {
			const li = btn.closest('li');
			if (!li) return;
			const id = li.getAttribute('data-service-id');
			if (!id) return;
			addServiceBtn.dataset.editingId = id;
			addServiceBtn.textContent = 'Hizmeti Güncelle';

			const name = li.getAttribute('data-service-name') || '';
			const duration = li.getAttribute('data-service-duration') || '30';
			const priceCents = Number(li.getAttribute('data-service-price-cents') || '0');
			const category = li.getAttribute('data-service-category') || 'men';

			document.getElementById('svcName').value = name;
			document.getElementById('svcDuration').value = String(duration);
			document.getElementById('svcPrice').value = String((priceCents / 100).toFixed(2));
			document.getElementById('svcCategory').value = category;

			document.getElementById('svcName').focus();
		});
	});

	Array.from(document.querySelectorAll('.deleteService')).forEach((btn) => {
		btn.addEventListener('click', async () => {
			const li = btn.closest('li');
			if (!li) return;
			const id = li.getAttribute('data-service-id');
			if (!id) return;
			if (!confirm('Bu hizmeti silmek istiyor musunuz?')) return;
			try {
				await deleteJson(`${apiBase}/services/${id}`);
				window.location.reload();
			} catch {
				alert('Silme hatası.');
			}
		});
	});

	Array.from(document.querySelectorAll('.editStaff')).forEach((btn) => {
		btn.addEventListener('click', () => {
			const li = btn.closest('li');
			if (!li) return;
			const id = li.getAttribute('data-staff-id');
			if (!id) return;
			addStaffBtn.dataset.editingId = id;
			addStaffBtn.textContent = 'Personeli Güncelle';

			const fullName = li.getAttribute('data-staff-full-name') || '';
			const category = li.getAttribute('data-staff-category') || 'men';
			const calendarId = li.getAttribute('data-staff-calendar-id') || '';

			document.getElementById('staffName').value = fullName;
			document.getElementById('staffCategory').value = category;
			document.getElementById('staffCalendarId').value = calendarId;

			document.getElementById('staffName').focus();
		});
	});

	Array.from(document.querySelectorAll('.deleteStaff')).forEach((btn) => {
		btn.addEventListener('click', async () => {
			const li = btn.closest('li');
			if (!li) return;
			const id = li.getAttribute('data-staff-id');
			if (!id) return;
			if (!confirm('Bu personeli silmek istiyor musunuz?')) return;
			try {
				await deleteJson(`${apiBase}/staff/${id}`);
				window.location.reload();
			} catch {
				alert('Silme hatası.');
			}
		});
	});

	function collectWeeklyHours(category) {
		const days = [];
		for (let dow = 0; dow <= 6; dow++) {
			const prefix = category === 'men' ? 'bh-men' : 'bh-women';
			const isClosed = Boolean(document.getElementById(`${prefix}-${dow}-closed`)?.checked);
			const startTime = document.getElementById(`${prefix}-${dow}-start`)?.value || '09:00';
			const endTime = document.getElementById(`${prefix}-${dow}-end`)?.value || '20:00';
			days.push({ dayOfWeek: dow, isClosed, startTime, endTime });
		}
		return days;
	}

	saveHoursMen?.addEventListener('click', async () => {
		const msg = document.getElementById('hoursMsgMen');
		try {
			msg.textContent = 'Kaydediliyor...';
			await postJson(`${apiBase}/hours`, { category: 'men', days: collectWeeklyHours('men') });
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = 'Çalışma saatleri kaydedildi.';
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası.';
		}
	});

	saveHoursWomen?.addEventListener('click', async () => {
		const msg = document.getElementById('hoursMsgWomen');
		try {
			msg.textContent = 'Kaydediliyor...';
			await postJson(`${apiBase}/hours`, { category: 'women', days: collectWeeklyHours('women') });
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = 'Çalışma saatleri kaydedildi.';
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası.';
		}
	});

	async function submitOverride(category) {
		const msg = document.getElementById(category === 'men' ? 'overrideMsgMen' : 'overrideMsgWomen');
		const prefix = category === 'men' ? 'ov-men' : 'ov-women';
		try {
			msg.textContent = 'Kaydediliyor...';
			const date = document.getElementById(`${prefix}-date`)?.value;
			const isClosed = Boolean(document.getElementById(`${prefix}-closed`)?.checked);
			const startTime = document.getElementById(`${prefix}-start`)?.value || '09:00';
			const endTime = document.getElementById(`${prefix}-end`)?.value || '20:00';
			const note = document.getElementById(`${prefix}-note`)?.value || null;

			if (!date) throw new Error('date required');
			await postJson(`${apiBase}/overrides`, { category, date, isClosed, startTime, endTime, note });
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = 'İstisna kaydedildi. Sayfa yenileniyor...';
			setTimeout(() => window.location.reload(), 400);
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası. Tarih ve saatleri kontrol edin.';
		}
	}

	addOverrideMen?.addEventListener('click', async () => submitOverride('men'));
	addOverrideWomen?.addEventListener('click', async () => submitOverride('women'));

	deleteOverrideButtons.forEach((btn) => {
		btn.addEventListener('click', async () => {
			const id = btn.getAttribute('data-id');
			if (!id) return;
			if (!confirm('Bu istisnayı silmek istiyor musunuz?')) return;
			try {
				await deleteJson(`${apiBase}/overrides/${id}`);
				window.location.reload();
			} catch {
				alert('Silme hatası.');
			}
		});
	});

	async function saveContact(category) {
		const msg = document.getElementById(category === 'men' ? 'contactMsgMen' : 'contactMsgWomen');
		try {
			msg.textContent = 'Kaydediliyor...';
			const prefix = category === 'men' ? 'contact-men' : 'contact-women';
			await postJson(`${apiBase}/contact`, {
				category,
				contact: {
					title: document.getElementById(`${prefix}-title`)?.value || null,
					address: document.getElementById(`${prefix}-address`)?.value || null,
					phone: document.getElementById(`${prefix}-phone`)?.value || null,
					email: document.getElementById(`${prefix}-email`)?.value || null,
					whatsapp: document.getElementById(`${prefix}-whatsapp`)?.value || null,
					mapsEmbedUrl: document.getElementById(`${prefix}-maps`)?.value || null,
				},
			});
			msg.className = 'mt-2 text-sm text-emerald-700';
			msg.textContent = 'İletişim bilgileri kaydedildi.';
		} catch {
			msg.className = 'mt-2 text-sm text-red-700';
			msg.textContent = 'Kayıt hatası.';
		}
	}

	saveContactMen?.addEventListener('click', async () => saveContact('men'));
	saveContactWomen?.addEventListener('click', async () => saveContact('women'));
})();
