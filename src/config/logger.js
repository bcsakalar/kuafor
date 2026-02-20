const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(process.cwd(), 'logs');
try {
	fs.mkdirSync(logsDir, { recursive: true });
} catch {
	// ignore
}

// Log formatı
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.errors({ stack: true }),
	winston.format.splat(),
	winston.format.printf(({ timestamp, level, message, stack }) => {
		const msg = `${timestamp} [${level.toUpperCase()}]: ${message}`;
		return stack ? `${msg}\n${stack}` : msg;
	})
);

// Logger oluştur
const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: logFormat,
	transports: [
		// Tüm loglar
		new winston.transports.File({
			filename: path.join(logsDir, 'combined.log'),
			maxsize: 5242880, // 5MB
			maxFiles: 5,
		}),
		// Sadece hatalar
		new winston.transports.File({
			filename: path.join(logsDir, 'error.log'),
			level: 'error',
			maxsize: 5242880, // 5MB
			maxFiles: 5,
		}),
		// Sipariş ve stok işlemleri için özel log
		new winston.transports.File({
			filename: path.join(logsDir, 'business.log'),
			level: 'info',
			maxsize: 5242880, // 5MB
			maxFiles: 5,
		}),
	],
});

// Her ortamda (Production dahil) console'a da yazdır ki Docker logs ile hatayı görelim
logger.add(
	new winston.transports.Console({
		format: winston.format.combine(
			winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
			winston.format.colorize(),
			winston.format.printf(({ timestamp, level, message, stack }) => {
				const msg = `${timestamp} [${level}]: ${message}`;
				return stack ? `${msg}\n${stack}` : msg;
			})
		),
	})
);

// Business işlemleri için özel logger
const businessLogger = {
	logOrder: (orderId, userId, action, details) => {
		logger.info(`[ORDER] ${action}`, {
			orderId,
			userId,
			action,
			...details,
		});
	},
	logStock: (productId, action, quantity, details) => {
		logger.info(`[STOCK] ${action}`, {
			productId,
			action,
			quantity,
			...details,
		});
	},
	logPayment: (orderId, amount, status, details) => {
		logger.info(`[PAYMENT] ${status}`, {
			orderId,
			amount,
			status,
			...details,
		});
	},
	logPaymentError: (orderId, iyzicoResponseOrError, details = {}) => {
		// Iyzipay responses often include: status, errorCode, errorMessage, errorGroup, locale, systemTime
		const src = iyzicoResponseOrError || {};
		const errorCode = src.errorCode || src.code || src.error_code || null;
		const errorMessage = src.errorMessage || src.message || src.error_message || null;
		const errorGroup = src.errorGroup || src.error_group || null;

		logger.error('[PAYMENT_ERROR] iyzico', {
			orderId: orderId || null,
			errorCode,
			errorMessage,
			errorGroup,
			status: src.status || null,
			locale: src.locale || null,
			systemTime: src.systemTime || null,
			// Keep a copy for debugging, but avoid logging secrets/card data.
			raw: src,
			...details,
		});
	},
	logAppointment: (appointmentId, action, details) => {
		logger.info(`[APPOINTMENT] ${action}`, {
			appointmentId,
			action,
			...details,
		});
	},
};

module.exports = { logger, businessLogger };
