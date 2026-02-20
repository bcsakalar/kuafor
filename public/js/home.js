// Home page hooks
(() => {
	// Smooth-scroll for in-page anchors (keeps mobile feeling premium).
	document.addEventListener('click', (e) => {
		const a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
		if (!a) return;
		const id = (a.getAttribute('href') || '').slice(1);
		if (!id) return;
		const el = document.getElementById(id);
		if (!el) return;
		e.preventDefault();
		el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	});
})();
