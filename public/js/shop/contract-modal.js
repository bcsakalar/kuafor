(() => {
	function isModifiedClick(ev) {
		return ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0;
	}

	function qs(root, sel) {
		return (root || document).querySelector(sel);
	}

	function qsa(root, sel) {
		return Array.from((root || document).querySelectorAll(sel));
	}

	function init() {
		const modal = document.getElementById('contractModal');
		if (!modal) return;

		const openers = qsa(document, '[data-contract-modal-open]');
		if (!openers.length) return;

		const closeBtn = qs(modal, '[data-contract-modal-close]');
		const backdrop = qs(modal, '[data-contract-modal-backdrop]');

		let lastActive = null;

		function open() {
			lastActive = document.activeElement;
			modal.classList.remove('hidden');
			document.body.style.overflow = 'hidden';
			setTimeout(() => {
				const focusTarget = qs(modal, '[data-contract-modal-initial-focus]') || closeBtn;
				focusTarget?.focus?.();
			}, 0);
		}

		function close() {
			modal.classList.add('hidden');
			document.body.style.overflow = '';
			try { lastActive?.focus?.(); } catch { /* ignore */ }
			lastActive = null;
		}

		openers.forEach((a) => {
			a.addEventListener('click', (ev) => {
				if (isModifiedClick(ev)) return;
				ev.preventDefault();
				open();
			});
		});

		closeBtn?.addEventListener('click', (ev) => {
			ev.preventDefault();
			close();
		});
		backdrop?.addEventListener('click', (ev) => {
			ev.preventDefault();
			close();
		});

		document.addEventListener('keydown', (ev) => {
			if (modal.classList.contains('hidden')) return;
			if (ev.key === 'Escape') {
				ev.preventDefault();
				close();
			}
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
