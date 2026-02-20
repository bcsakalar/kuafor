const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const ADMIN_IMAGE_UPLOAD_MAX_BYTES = Number(process.env.ADMIN_IMAGE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024);

function toWholeMb(bytes) {
	return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

const ADMIN_IMAGE_UPLOAD_MAX_MB = toWholeMb(ADMIN_IMAGE_UPLOAD_MAX_BYTES);

const UPLOAD_DIR = path.join(__dirname, '../../public/images/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

const SHOP_BULK_UPLOAD_MAX_BYTES = Number(process.env.SHOP_BULK_UPLOAD_MAX_BYTES || 5 * 1024 * 1024);
const SHOP_BULK_UPLOAD_MAX_MB = toWholeMb(SHOP_BULK_UPLOAD_MAX_BYTES);

const ALLOWED_BULK_EXTS = new Set(['.csv', '.xlsx']);
const ALLOWED_BULK_MIMES = new Set([
	'text/csv',
	'application/csv',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function getSafeExt(file) {
	const ext = path.extname(file.originalname || '').toLowerCase();
	if (ALLOWED_IMAGE_EXTS.has(ext)) return ext;
	if (file.mimetype === 'image/png') return '.png';
	if (file.mimetype === 'image/jpeg') return '.jpg';
	return '';
}

function isAllowedImage(file) {
	const ext = path.extname(file.originalname || '').toLowerCase();
	if (ALLOWED_IMAGE_EXTS.has(ext)) return true;
	if (ALLOWED_IMAGE_MIMES.has(file.mimetype)) return true;
	return false;
}

function isAllowedBulkFile(file) {
	const ext = path.extname(file.originalname || '').toLowerCase();
	if (ALLOWED_BULK_EXTS.has(ext)) return true;
	if (ALLOWED_BULK_MIMES.has(file.mimetype)) return true;
	return false;
}

function uniqueId() {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return crypto.randomBytes(16).toString('hex');
}

function createImageUpload({ prefix }) {
	return multer({
		storage: multer.diskStorage({
			destination: UPLOAD_DIR,
			filename: (_req, file, cb) => {
				const ext = getSafeExt(file);
				const id = uniqueId();
				cb(null, `${prefix}_${id}${ext}`);
			},
		}),
		fileFilter: (_req, file, cb) => {
			if (isAllowedImage(file)) return cb(null, true);
			return cb(new Error('Sadece .png ve .jpg görselleri yükleyebilirsiniz.'));
		},
		limits: {
			fileSize: ADMIN_IMAGE_UPLOAD_MAX_BYTES,
		},
	});
}

function createBulkUpload() {
	return multer({
		storage: multer.memoryStorage(),
		fileFilter: (_req, file, cb) => {
			if (isAllowedBulkFile(file)) return cb(null, true);
			return cb(new Error('Sadece .csv ve .xlsx dosyaları yükleyebilirsiniz.'));
		},
		limits: {
			fileSize: SHOP_BULK_UPLOAD_MAX_BYTES,
		},
	});
}

function normalizeUploadError(err) {
	if (!err) return null;

	if (err.name === 'MulterError') {
		if (err.code === 'LIMIT_FILE_SIZE') {
			return { statusCode: 413, code: 'file_too_large' };
		}
		return { statusCode: 400, code: 'upload_error' };
	}

	if (typeof err.message === 'string' && err.message.includes('Sadece .png ve .jpg')) {
		return { statusCode: 400, code: 'invalid_file_type' };
	}

	if (typeof err.message === 'string' && err.message.includes('Sadece .csv ve .xlsx')) {
		return { statusCode: 400, code: 'invalid_file_type' };
	}

	return null;
}

function getHumanMessageForUploadCode(code) {
	if (code === 'file_too_large') return `Dosya çok büyük. Maksimum boyut: ${ADMIN_IMAGE_UPLOAD_MAX_MB}MB.`;
	if (code === 'invalid_file_type') return 'Sadece .png ve .jpg görselleri yükleyebilirsiniz.';
	if (code === 'upload_error') return 'Dosya yüklenirken bir sorun oluştu.';
	return null;
}

const adminImageUpload = createImageUpload({ prefix: 'img' });
const shopImageUpload = createImageUpload({ prefix: 'shop' });
const shopBulkUpload = createBulkUpload();

module.exports = {
	ADMIN_IMAGE_UPLOAD_MAX_BYTES,
	ADMIN_IMAGE_UPLOAD_MAX_MB,
	SHOP_BULK_UPLOAD_MAX_BYTES,
	SHOP_BULK_UPLOAD_MAX_MB,
	UPLOAD_DIR,
	adminImageUpload,
	shopImageUpload,
	shopBulkUpload,
	normalizeUploadError,
	getHumanMessageForUploadCode,
};
