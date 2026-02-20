/**
 * Service Worker for PWA Support
 * Enables offline functionality and caching
 */

const CACHE_NAME = 'berber-salon-v1';
const STATIC_CACHE = 'berber-static-v1';
const DYNAMIC_CACHE = 'berber-dynamic-v1';

// Static assets to cache on install
const STATIC_ASSETS = [
	'/',
	'/public/css/styles.css',
	'/public/js/theme-init.js',
	'/public/js/theme.js',
	'/public/js/nav.js',
	'/public/js/tailwind-config.js',
	'/public/logo/logo.jpg',
	'/public/svg/ma_symbol.svg',
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
	console.log('[SW] Installing service worker...');
	event.waitUntil(
		caches.open(STATIC_CACHE)
			.then((cache) => {
				console.log('[SW] Pre-caching static assets');
				return cache.addAll(STATIC_ASSETS.map(url => {
					return new Request(url, { cache: 'reload' });
				})).catch(err => {
					console.warn('[SW] Some assets failed to cache:', err);
				});
			})
			.then(() => self.skipWaiting())
	);
});

// Activate event - cleanup old caches
self.addEventListener('activate', (event) => {
	console.log('[SW] Activating service worker...');
	event.waitUntil(
		caches.keys()
			.then((cacheNames) => {
				return Promise.all(
					cacheNames
						.filter((name) => {
							return name !== STATIC_CACHE && 
								   name !== DYNAMIC_CACHE && 
								   name.startsWith('berber-');
						})
						.map((name) => {
							console.log('[SW] Deleting old cache:', name);
							return caches.delete(name);
						})
				);
			})
			.then(() => self.clients.claim())
	);
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Skip non-GET requests
	if (request.method !== 'GET') return;

	// Skip WebSocket and API requests
	if (url.pathname.startsWith('/socket.io') || 
		url.pathname.startsWith('/api/') ||
		url.pathname.includes('/payment-callback')) {
		return;
	}

	// Skip external requests
	if (url.origin !== location.origin) {
		// Allow CDN requests through with network-first
		if (url.hostname.includes('cdn.jsdelivr.net')) {
			event.respondWith(networkFirst(request, DYNAMIC_CACHE));
		}
		return;
	}

	// Static assets - cache first
	if (isStaticAsset(url.pathname)) {
		event.respondWith(cacheFirst(request, STATIC_CACHE));
		return;
	}

	// HTML pages - network first with cache fallback
	if (request.headers.get('accept')?.includes('text/html')) {
		event.respondWith(networkFirst(request, DYNAMIC_CACHE));
		return;
	}

	// Other requests - stale while revalidate
	event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
});

// Cache strategies
async function cacheFirst(request, cacheName) {
	const cachedResponse = await caches.match(request);
	if (cachedResponse) {
		return cachedResponse;
	}
	
	try {
		const networkResponse = await fetch(request);
		if (networkResponse.ok) {
			const cache = await caches.open(cacheName);
			cache.put(request, networkResponse.clone());
		}
		return networkResponse;
	} catch (error) {
		console.warn('[SW] Network request failed:', request.url);
		return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
	}
}

async function networkFirst(request, cacheName) {
	try {
		const networkResponse = await fetch(request);
		if (networkResponse.ok) {
			const cache = await caches.open(cacheName);
			cache.put(request, networkResponse.clone());
		}
		return networkResponse;
	} catch (error) {
		console.warn('[SW] Network request failed, trying cache:', request.url);
		const cachedResponse = await caches.match(request);
		if (cachedResponse) {
			return cachedResponse;
		}
		// Return offline page for HTML requests
		if (request.headers.get('accept')?.includes('text/html')) {
			return caches.match('/offline.html') || 
				new Response(getOfflineHTML(), {
					headers: { 'Content-Type': 'text/html' }
				});
		}
		return new Response('Offline', { status: 503 });
	}
}

async function staleWhileRevalidate(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cachedResponse = await cache.match(request);
	
	const fetchPromise = fetch(request)
		.then((networkResponse) => {
			if (networkResponse.ok) {
				cache.put(request, networkResponse.clone());
			}
			return networkResponse;
		})
		.catch(() => cachedResponse);

	return cachedResponse || fetchPromise;
}

// Helper functions
function isStaticAsset(pathname) {
	const staticExtensions = ['.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.woff', '.woff2'];
	return staticExtensions.some(ext => pathname.endsWith(ext)) ||
		   pathname.startsWith('/public/');
}

function getOfflineHTML() {
	return `<!DOCTYPE html>
<html lang="tr">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Çevrimdışı</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			text-align: center;
			padding: 20px;
		}
		.container { max-width: 400px; }
		h1 { font-size: 2rem; margin-bottom: 1rem; }
		p { font-size: 1.1rem; opacity: 0.9; margin-bottom: 2rem; }
		button {
			background: white;
			color: #764ba2;
			border: none;
			padding: 12px 24px;
			border-radius: 8px;
			font-size: 1rem;
			cursor: pointer;
			transition: transform 0.2s;
		}
		button:hover { transform: scale(1.05); }
		.icon { font-size: 4rem; margin-bottom: 1rem; }
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">📡</div>
		<h1>Çevrimdışısınız</h1>
		<p>İnternet bağlantınızı kontrol edip tekrar deneyin.</p>
		<button onclick="location.reload()">Tekrar Dene</button>
	</div>
</body>
</html>`;
}

// Background sync for offline form submissions (if supported)
self.addEventListener('sync', (event) => {
	if (event.tag === 'sync-bookings') {
		event.waitUntil(syncOfflineBookings());
	}
});

async function syncOfflineBookings() {
	// This would sync any offline booking attempts
	// Implementation depends on IndexedDB storage of offline requests
	console.log('[SW] Syncing offline bookings...');
}

// Push notifications (if implemented)
self.addEventListener('push', (event) => {
	if (!event.data) return;
	
	const data = event.data.json();
	const options = {
		body: data.body || 'Yeni bildirim',
		icon: '/public/logo/logo.jpg',
		badge: '/public/logo/logo.jpg',
		vibrate: [100, 50, 100],
		data: {
			url: data.url || '/',
		},
	};
	
	event.waitUntil(
		self.registration.showNotification(data.title || 'Berber Salon', options)
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = event.notification.data?.url || '/';
	event.waitUntil(
		clients.openWindow(url)
	);
});
