/**
 * In-memory cache service for frequently accessed data
 * Reduces database load for categories, services, settings etc.
 */

const { logger } = require('../config/logger');

class CacheService {
	constructor() {
		this.cache = new Map();
		this.stats = {
			hits: 0,
			misses: 0,
			sets: 0,
			deletes: 0,
		};
	}

	/**
	 * Get item from cache
	 * @param {string} key - Cache key
	 * @returns {*} Cached value or undefined
	 */
	get(key) {
		const item = this.cache.get(key);
		if (!item) {
			this.stats.misses++;
			return undefined;
		}

		// Check TTL
		if (item.expiresAt && Date.now() > item.expiresAt) {
			this.cache.delete(key);
			this.stats.misses++;
			return undefined;
		}

		this.stats.hits++;
		return item.value;
	}

	/**
	 * Set item in cache
	 * @param {string} key - Cache key
	 * @param {*} value - Value to cache
	 * @param {number} ttlMs - Time to live in milliseconds (default: 5 minutes)
	 */
	set(key, value, ttlMs = 5 * 60 * 1000) {
		this.cache.set(key, {
			value,
			expiresAt: ttlMs > 0 ? Date.now() + ttlMs : null,
			createdAt: Date.now(),
		});
		this.stats.sets++;
	}

	/**
	 * Delete item from cache
	 * @param {string} key - Cache key
	 */
	delete(key) {
		const deleted = this.cache.delete(key);
		if (deleted) this.stats.deletes++;
		return deleted;
	}

	/**
	 * Delete items matching pattern
	 * @param {string} pattern - Pattern to match (supports * wildcard)
	 */
	deletePattern(pattern) {
		const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
		let count = 0;
		for (const key of this.cache.keys()) {
			if (regex.test(key)) {
				this.cache.delete(key);
				count++;
			}
		}
		this.stats.deletes += count;
		return count;
	}

	/**
	 * Clear all cache
	 */
	clear() {
		const size = this.cache.size;
		this.cache.clear();
		this.stats.deletes += size;
		return size;
	}

	/**
	 * Get or set with async function
	 * @param {string} key - Cache key
	 * @param {Function} fetchFn - Async function to fetch data if not cached
	 * @param {number} ttlMs - Time to live in milliseconds
	 * @returns {Promise<*>} Cached or fetched value
	 */
	async getOrSet(key, fetchFn, ttlMs = 5 * 60 * 1000) {
		const cached = this.get(key);
		if (cached !== undefined) {
			return cached;
		}

		try {
			const value = await fetchFn();
			this.set(key, value, ttlMs);
			return value;
		} catch (err) {
			logger.error('[cache] getOrSet fetch failed', { key, message: err?.message });
			throw err;
		}
	}

	/**
	 * Get cache statistics
	 */
	getStats() {
		return {
			...this.stats,
			size: this.cache.size,
			hitRate: this.stats.hits + this.stats.misses > 0
				? ((this.stats.hits / (this.stats.hits + this.stats.misses)) * 100).toFixed(2) + '%'
				: '0%',
		};
	}

	/**
	 * Cleanup expired entries
	 */
	cleanup() {
		const now = Date.now();
		let cleaned = 0;
		for (const [key, item] of this.cache.entries()) {
			if (item.expiresAt && now > item.expiresAt) {
				this.cache.delete(key);
				cleaned++;
			}
		}
		return cleaned;
	}
}

// Singleton instance
const cacheService = new CacheService();

// Periodic cleanup every 5 minutes
setInterval(() => {
	const cleaned = cacheService.cleanup();
	if (cleaned > 0) {
		logger.debug('[cache] cleanup removed expired entries', { count: cleaned });
	}
}, 5 * 60 * 1000);

// Cache key constants
const CACHE_KEYS = {
	CATEGORIES: 'shop:categories',
	SERVICES: (category) => `booking:services:${category}`,
	STAFF: (category) => `booking:staff:${category}`,
	BUSINESS_HOURS: (category, dateStr) => `booking:hours:${category}:${dateStr}`,
	SETTINGS: 'app:settings',
	PRODUCTS_LIST: (categoryId, page) => `shop:products:${categoryId || 'all'}:${page || 1}`,
	PRODUCT_DETAIL: (productId) => `shop:product:${productId}`,
};

// Cache TTLs in milliseconds
const CACHE_TTL = {
	CATEGORIES: 10 * 60 * 1000, // 10 minutes
	SERVICES: 5 * 60 * 1000, // 5 minutes
	STAFF: 5 * 60 * 1000, // 5 minutes
	BUSINESS_HOURS: 2 * 60 * 1000, // 2 minutes
	SETTINGS: 5 * 60 * 1000, // 5 minutes
	PRODUCTS_LIST: 2 * 60 * 1000, // 2 minutes
	PRODUCT_DETAIL: 5 * 60 * 1000, // 5 minutes
};

module.exports = {
	cacheService,
	CACHE_KEYS,
	CACHE_TTL,
};
