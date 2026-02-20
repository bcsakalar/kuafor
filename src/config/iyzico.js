const Iyzipay = require('iyzipay');

function requiredEnv(name) {
	const value = String(process.env[name] || '').trim();
	if (!value) throw new Error(`[iyzico] Missing required env var: ${name}`);
	return value;
}

const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const isProduction = nodeEnv === 'production';

// Iyzipay endpoints:
// - Sandbox: https://sandbox-api.iyzipay.com
// - Production: https://api.iyzipay.com
const uri =
	String(process.env.IYZICO_URI || '').trim()
	|| (isProduction ? 'https://api.iyzipay.com' : 'https://sandbox-api.iyzipay.com');

const apiKey = isProduction ? requiredEnv('IYZICO_API_KEY') : String(process.env.IYZICO_API_KEY || '').trim();
const secretKey = isProduction ? requiredEnv('IYZICO_SECRET_KEY') : String(process.env.IYZICO_SECRET_KEY || '').trim();

const iyzico = new Iyzipay({
	apiKey,
	secretKey,
	uri,
});

module.exports = { iyzico };
