const { Pool } = require('pg');
const { logger } = require('./logger');

function toBool(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback;
	return String(value).toLowerCase() === 'true';
}

function requiredEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`[db] Missing required env var: ${name}`);
	return value;
}

const isProduction = process.env.NODE_ENV === 'production';

const useDatabaseUrl = Boolean(process.env.DATABASE_URL);

const connectionConfig = useDatabaseUrl
	? { connectionString: process.env.DATABASE_URL }
	: {
		host: isProduction ? requiredEnv('DB_HOST') : (process.env.DB_HOST || '127.0.0.1'),
		port: Number(process.env.DB_PORT || 5432),
		database: isProduction ? requiredEnv('DB_NAME') : (process.env.DB_NAME || 'berber'),
		user: isProduction ? requiredEnv('DB_USER') : (process.env.DB_USER || 'berber'),
		password: isProduction ? requiredEnv('DB_PASSWORD') : (process.env.DB_PASSWORD || 'berber'),
	};

const pool = new Pool({
	...connectionConfig,
	ssl: toBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : false,
	max: 10,
	idleTimeoutMillis: 30_000,
});

// Log initial connectivity (best-effort)
pool.connect()
	.then((client) => {
		try {
			client.release();
		} catch {
			// ignore
		}
		logger.info('Veritabanına bağlanıldı');
	})
	.catch((error) => {
		logger.error('Veritabanı bağlantı hatası', {
			message: error?.message,
			stack: error?.stack,
		});
	});

pool.on('error', (err) => {
	logger.error('Veritabanı bağlantı hatası', {
		message: err?.message,
		stack: err?.stack,
	});
});

module.exports = { pool };
