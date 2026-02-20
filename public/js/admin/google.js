// Admin Google integration page DOM hooks
(() => {
	const adminBasePath = (typeof window.__ADMIN_BASE_PATH__ === 'string') ? window.__ADMIN_BASE_PATH__ : '';
	const apiBase = adminBasePath ? `${adminBasePath}/api` : '/api';

	const statusEl = document.getElementById('googleStatus');
	const connectBtn = document.getElementById('googleConnectBtn');
	const disconnectBtn = document.getElementById('googleDisconnectBtn');

	if (!statusEl || !connectBtn || !disconnectBtn) return;

	function setConnectEnabled(enabled) {
		if (enabled) {
			connectBtn.classList.remove('opacity-50', 'pointer-events-none');
			connectBtn.setAttribute('aria-disabled', 'false');
		} else {
			connectBtn.classList.add('opacity-50', 'pointer-events-none');
			connectBtn.setAttribute('aria-disabled', 'true');
		}
	}

	function setVisibility({ connected, configured }) {
		// Keep it simple: one primary action at a time.
		if (!configured) {
			connectBtn.style.display = '';
			disconnectBtn.style.display = 'none';
			return;
		}
		connectBtn.style.display = connected ? 'none' : '';
		disconnectBtn.style.display = connected ? '' : 'none';
	}

	async function refreshStatus() {
		try {
			const resp = await fetch(`${apiBase}/google/status?t=${Date.now()}`, {
				headers: { 'Accept': 'application/json' },
				credentials: 'same-origin',
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			const data = await resp.json();

			if (!data.configured) {
				statusEl.textContent = 'Durum: Yapılandırma yok (.env eksik olabilir)';
				setVisibility({ connected: false, configured: false });
				setConnectEnabled(true);
				return;
			}

			setVisibility({ connected: Boolean(data.connected), configured: true });
			setConnectEnabled(true);
			statusEl.textContent = data.connected ? 'Durum: Bağlı' : 'Durum: Bağlı değil';
		} catch (e) {
			console.error(e);
			statusEl.textContent = 'Durum: Bilinmiyor (status alınamadı)';
			setVisibility({ connected: false, configured: true });
			setConnectEnabled(true);
		}
	}

	disconnectBtn.addEventListener('click', async () => {
		disconnectBtn.disabled = true;
		try {
			await fetch(`${apiBase}/google/disconnect`, {
				method: 'POST',
				headers: { 'Accept': 'application/json' },
				credentials: 'same-origin',
			});
		} catch (e) {
			console.error(e);
		} finally {
			disconnectBtn.disabled = false;
			await refreshStatus();
		}
	});

	refreshStatus();
})();
