const { google } = require('googleapis');

function unique(arr) {
	return Array.from(new Set((arr || []).filter(Boolean)));
}

function getConfiguredRedirectUris() {
	const multi = String(process.env.SHOP_GOOGLE_REDIRECT_URIS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const single = String(process.env.SHOP_GOOGLE_REDIRECT_URI || '').trim();
	if (single) multi.push(single);

	return unique(multi);
}

function getClientConfig() {
	// Prefer shop-specific env vars; fallback to existing GOOGLE_* for convenience.
	const clientId = String(process.env.SHOP_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '').trim();
	const clientSecret = String(process.env.SHOP_GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '').trim();
	return { clientId, clientSecret };
}

function buildRequestRedirectUri(req) {
	if (!req) return null;
	const host = (req.get('host') || '').trim();
	if (!host) return null;
	return `${req.protocol}://${host}/auth/google/callback`;
}

function resolveRedirectUri({ req }) {
	const candidates = getConfiguredRedirectUris();
	const requested = buildRequestRedirectUri(req);
	if (requested && candidates.includes(requested)) return requested;
	return candidates[0] || requested || null;
}

function getResolvedRedirectUri(req) {
	return resolveRedirectUri({ req });
}

function buildOAuthClient({ clientId, clientSecret, redirectUri }) {
	return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthUrl(req, { state }) {
	const { clientId, clientSecret } = getClientConfig();
	const redirectUri = resolveRedirectUri({ req });
	if (!clientId || !clientSecret || !redirectUri) return null;

	const oAuth2Client = buildOAuthClient({ clientId, clientSecret, redirectUri });
	return oAuth2Client.generateAuthUrl({
		access_type: 'online',
		prompt: 'select_account',
		scope: ['openid', 'email', 'profile'],
		include_granted_scopes: true,
		state,
	});
}

async function exchangeCodeForProfile(req, code) {
	const { clientId, clientSecret } = getClientConfig();
	const redirectUri = resolveRedirectUri({ req });
	if (!clientId || !clientSecret || !redirectUri) {
		throw new Error('Shop Google OAuth config missing');
	}

	const oAuth2Client = buildOAuthClient({ clientId, clientSecret, redirectUri });
	const { tokens } = await oAuth2Client.getToken(code);
	const idToken = tokens && tokens.id_token;
	if (!idToken) throw new Error('Missing id_token');

	const ticket = await oAuth2Client.verifyIdToken({
		idToken,
		audience: clientId,
	});
	const payload = ticket.getPayload();
	if (!payload) throw new Error('Invalid id_token payload');

	const email = String(payload.email || '').trim().toLowerCase();
	const emailVerified = payload.email_verified === true;
	const sub = String(payload.sub || '').trim();
	const fullName = String(payload.name || '').trim() || null;

	if (!sub) throw new Error('Missing Google sub');
	if (!email) throw new Error('Missing email');
	if (!emailVerified) {
		const err = new Error('Email not verified');
		err.statusCode = 401;
		throw err;
	}

	return { email, fullName, googleSub: sub };
}

module.exports = {
	getAuthUrl,
	exchangeCodeForProfile,
	getResolvedRedirectUri,
};
