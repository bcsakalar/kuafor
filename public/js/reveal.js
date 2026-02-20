// Scroll reveal using IntersectionObserver
(() => {
	const items = Array.from(document.querySelectorAll('[data-reveal]'));
	if (!items.length) return;

	const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (prefersReduced) {
		items.forEach((el) => el.classList.add('is-in', 'visible'));
		return;
	}

	items.forEach((el) => {
		const raw = el.getAttribute('data-reveal-delay');
		const ms = raw ? Number(raw) : 0;
		if (Number.isFinite(ms) && ms > 0) {
			el.style.setProperty('--reveal-delay', `${ms}ms`);
		}
	});

	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('is-in', 'visible');
				io.unobserve(entry.target);
			}
		},
		{ root: null, threshold: 0.16 }
	);

	items.forEach((el) => io.observe(el));
})();
