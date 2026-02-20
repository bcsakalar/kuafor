function extractIframeSrc(raw) {
	const m = String(raw || '').match(/\bsrc\s*=\s*["']([^"']+)["']/i);
	return m ? m[1] : '';
}

function normalizeMapsEmbedUrl(input) {
	if (!input) return '';

	let raw = String(input).trim();
	if (!raw) return '';

	// Allow users to paste full <iframe ...> embed snippets.
	if (raw.includes('<iframe')) {
		const src = extractIframeSrc(raw);
		if (src) raw = src;
	}

	raw = raw.replace(/&amp;/g, '&');

	let url;
	try {
		url = new URL(raw);
	} catch {
		// If it's not a valid URL, don't render it as iframe src.
		return '';
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';

	const host = url.hostname.toLowerCase();
	const isGoogle = host === 'www.google.com' || host === 'google.com' || host.endsWith('.google.com');

	if (isGoogle) {
		// If user pasted Maps Embed API v1 URLs (often with ?key=...), prefer a no-key embed.
		if (url.pathname.startsWith('/maps/embed/v1/')) {
			const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
			if (q) {
				const safe = new URL('https://www.google.com/maps');
				safe.searchParams.set('q', q);
				safe.searchParams.set('output', 'embed');
				return safe.toString();
			}

			// If we can't translate safely, don't render (avoids noisy console errors).
			return '';
		}

		// Canonical embed URL.
		if (url.pathname.startsWith('/maps/embed')) {
			return url.toString();
		}

		// For share links like /maps/place/... try forcing output=embed.
		if (url.pathname.startsWith('/maps')) {
			url.searchParams.set('output', 'embed');
			return url.toString();
		}
	}

	// Allow non-Google providers if desired, but require http(s).
	return url.toString();
}

module.exports = {
	normalizeMapsEmbedUrl,
};
