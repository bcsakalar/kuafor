const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

function loadEnv() {
	const nodeEnv = String(process.env.NODE_ENV || 'development').trim() || 'development';
	const candidates = [path.join(process.cwd(), `.env.${nodeEnv}`)];

	for (const envPath of candidates) {
		try {
			if (fs.existsSync(envPath)) {
				dotenv.config({ path: envPath });
				return;
			}
		} catch {
			// ignore and continue
		}
	}

	// Fallback: rely on process env only.
}

loadEnv();

const http = require('http');
const app = require('./app');
const socketService = require('./services/socketService');
const { startAppointmentLifecycleJobs } = require('./jobs/appointmentLifecycle');
const { startPaymentSyncJobs, startReconciliationJob } = require('./jobs/paymentSync');
const adminModel = require('./models/adminModel');
const { logger } = require('./config/logger');

const port = Number(process.env.PORT || 3000);

const server = http.createServer(app);

function shutdownOnFatal(err, origin) {
	try {
		logger.error(`Fatal error (${origin})`, {
			message: err?.message,
			stack: err?.stack,
		});
	} catch {
		// ignore
	}

	try {
		server.close(() => process.exit(1));
		// If server doesn't close in time, force-exit.
		setTimeout(() => process.exit(1), 10_000).unref();
	} catch {
		process.exit(1);
	}
}

process.on('uncaughtException', (err) => shutdownOnFatal(err, 'uncaughtException'));
process.on('unhandledRejection', (reason) => {
	const err = reason instanceof Error ? reason : new Error(String(reason));
	shutdownOnFatal(err, 'unhandledRejection');
});

// Socket.IO (real-time)
socketService.init(server);

server.listen(port, () => {
	logger.info(`[server] listening on :${port}`);
	startAppointmentLifecycleJobs({
		cleanupDaysToKeep: Number(process.env.PAST_APPOINTMENTS_RETENTION_DAYS || 14),
	});
	// Keeps Iyzico checkout orders in sync even when 3DS redirect/callback fails.
	// Disable with PAYMENT_SYNC_ENABLED=0.
	if (String(process.env.PAYMENT_SYNC_ENABLED || '1') !== '0') {
		startPaymentSyncJobs({
			intervalMs: Number(process.env.PAYMENT_SYNC_INTERVAL_MS || 60_000),
			sinceMinutes: Number(process.env.PAYMENT_SYNC_SINCE_MINUTES || 180),
			limit: Number(process.env.PAYMENT_SYNC_LIMIT || 20),
		});
		// Payment reconciliation job - verifies payment statuses with Iyzico
		// Runs every 6 hours by default
		startReconciliationJob({
			intervalMs: Number(process.env.RECONCILIATION_INTERVAL_MS || 6 * 60 * 60 * 1000),
			daysBefore: Number(process.env.RECONCILIATION_DAYS_BEFORE || 7),
			limit: Number(process.env.RECONCILIATION_LIMIT || 50),
		});
	}
	// Auto-create initial admin (prod friendly)
	// - If ADMIN_EMAIL + ADMIN_PASSWORD are set and the admin does not exist, create it.
	// - If there are zero admins but creds are missing, log a clear warning.
	(async () => {
		try {
			const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
			const password = String(process.env.ADMIN_PASSWORD || '').trim();
			const fullName = String(process.env.ADMIN_FULL_NAME || 'Admin').trim();

			const count = await adminModel.countAdmins();

			if (!email || !password) {
				if (count === 0) {
					logger.warn(
						'[bootstrap] no admins exist but ADMIN_EMAIL/ADMIN_PASSWORD are not set; cannot auto-create initial admin. '
						+ 'Make sure your .env.production is present (or environment variables are set) before starting the server.'
					);
				}
				return;
			}

			const existing = await adminModel.findByEmail(email);
			if (!existing) {
				await adminModel.createAdmin({ email, password, fullName });
				logger.info(`[bootstrap] admin created: ${email}`);
			}
		} catch (err) {
			logger.error('[bootstrap] failed to create admin', {
				message: err?.message,
				stack: err?.stack,
			});
		}
	})();
});
