const path = require('path');
const fs = require('fs/promises');

let sharp;
try {
	// Optional dependency. If not installed, middleware becomes a no-op.
	// eslint-disable-next-line global-require
	sharp = require('sharp');
} catch (_err) {
	sharp = null;
}

function toInt(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function optimizeUploadedImage(options = {}) {
	const maxWidth = toInt(options.maxWidth ?? process.env.UPLOAD_IMAGE_MAX_WIDTH, 1600);
	const jpegQuality = toInt(options.jpegQuality ?? process.env.UPLOAD_IMAGE_JPEG_QUALITY, 82);

	return async (req, _res, next) => {
		try {
			if (!sharp) return next();
			if (!req.file || !req.file.path || !req.file.filename) return next();

			const inputPath = req.file.path;
			const ext = path.extname(req.file.filename).toLowerCase();
			if (!['.jpg', '.jpeg', '.png'].includes(ext)) return next();

			const tmpPath = `${inputPath}.tmp`;

			let img = sharp(inputPath, { failOn: 'none' }).rotate();
			const meta = await img.metadata();
			if (meta && meta.width && meta.width > maxWidth) {
				img = img.resize({ width: maxWidth, withoutEnlargement: true });
			}

			if (ext === '.png') {
				img = img.png({ compressionLevel: 9, adaptiveFiltering: true });
			} else {
				img = img.jpeg({ quality: jpegQuality, mozjpeg: true });
			}

			await img.toFile(tmpPath);
			await fs.rm(inputPath, { force: true });
			await fs.rename(tmpPath, inputPath);
			return next();
		} catch (err) {
			return next(err);
		}
	};
}

module.exports = { optimizeUploadedImage };