// Apply category theme ASAP to avoid flashing.
// Persists the user's choice in localStorage: 'men' | 'women'.
(function () {
	try {
		var stored = localStorage.getItem('category');
		var category = stored === 'women' ? 'women' : 'men';
		document.documentElement.setAttribute('data-category', category);
	} catch {
		// Default for strict environments
		document.documentElement.setAttribute('data-category', 'men');
	}
})();
