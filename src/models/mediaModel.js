const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const MEDIA_PATH = path.join(__dirname, '..', '..', 'data', 'media.json');

function safePublicSrc(src) {
	const s = String(src || '').trim();
	if (!s) return '';
	// Only allow local public paths for now. Keeps CSP simple.
	if (!s.startsWith('/public/')) return '';
	// Basic hardening against weird schemes.
	if (s.toLowerCase().startsWith('javascript:')) return '';
	return s;
}

function safeText(v, max = 200) {
	const s = String(v || '').trim();
	return s.length > max ? s.slice(0, max) : s;
}

function defaultMedia() {
	return {
		slots: {},
		gallery: [],
	};
}

function normalizeCategory(v) {
	const c = String(v || '').toLowerCase();
	if (c === 'men' || c === 'women' || c === 'both') return c;
	return 'both';
}

async function readMedia() {
	try {
		const raw = await fs.readFile(MEDIA_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		return {
			slots: parsed && typeof parsed.slots === 'object' && parsed.slots ? parsed.slots : {},
			gallery: Array.isArray(parsed?.gallery)
				? parsed.gallery.map((it) => ({
					...it,
					category: normalizeCategory(it?.category),
				}))
				: [],
		};
	} catch {
		return defaultMedia();
	}
}

async function writeMedia(media) {
	const dir = path.dirname(MEDIA_PATH);
	await fs.mkdir(dir, { recursive: true });

	const tmpPath = MEDIA_PATH + '.tmp';
	const json = JSON.stringify(media, null, '\t') + '\n';
	await fs.writeFile(tmpPath, json, 'utf8');
	await fs.rename(tmpPath, MEDIA_PATH);
}

async function getMedia() {
	return readMedia();
}

async function upsertSlot({ slotKey, src, alt }) {
	const media = await readMedia();
	if (!media.slots || typeof media.slots !== 'object') media.slots = {};

	const cleanSrc = safePublicSrc(src);
	const cleanAlt = safeText(alt, 200);
	const prev = media.slots[String(slotKey)] || {};

	media.slots[String(slotKey)] = {
		...prev,
		src: cleanSrc || prev.src || '/public/images/placeholder.svg',
		alt: cleanAlt || prev.alt || '',
	};

	await writeMedia(media);
	return media.slots[String(slotKey)];
}

function newGalleryId() {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return crypto.randomBytes(12).toString('hex');
}

async function addGalleryItem({ src, alt, category }) {
	const media = await readMedia();
	if (!Array.isArray(media.gallery)) media.gallery = [];

	const cleanSrc = safePublicSrc(src);
	if (!cleanSrc) throw new Error('Invalid src');

	const item = {
		id: newGalleryId(),
		src: cleanSrc,
		alt: safeText(alt, 200) || 'Galeri görseli',
		category: normalizeCategory(category),
	};

	media.gallery.push(item);
	await writeMedia(media);
	return item;
}

async function updateGalleryItem({ id, src, alt, category }) {
	const media = await readMedia();
	if (!Array.isArray(media.gallery)) media.gallery = [];
	const idx = media.gallery.findIndex((x) => String(x?.id) === String(id));
	if (idx === -1) throw new Error('Not found');

	const prev = media.gallery[idx] || {};
	const cleanSrc = src ? safePublicSrc(src) : '';
	const cleanAlt = alt != null ? safeText(alt, 200) : '';
	const nextCategory = category != null ? normalizeCategory(category) : normalizeCategory(prev?.category);

	media.gallery[idx] = {
		...prev,
		src: cleanSrc || prev.src,
		alt: cleanAlt || prev.alt,
		category: nextCategory,
	};

	await writeMedia(media);
	return media.gallery[idx];
}

async function deleteGalleryItem({ id }) {
	const media = await readMedia();
	if (!Array.isArray(media.gallery)) media.gallery = [];
	const before = media.gallery.length;
	media.gallery = media.gallery.filter((x) => String(x?.id) !== String(id));
	if (media.gallery.length === before) throw new Error('Not found');
	await writeMedia(media);
	return true;
}

module.exports = {
	getMedia,
	upsertSlot,
	addGalleryItem,
	updateGalleryItem,
	deleteGalleryItem,
};
