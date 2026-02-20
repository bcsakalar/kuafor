const { google } = require('googleapis');
const { pool } = require('../config/db');

function unique(arr) {
	return Array.from(new Set((arr || []).filter(Boolean)));
}

function getConfiguredRedirectUris() {
	const multi = String(process.env.GOOGLE_REDIRECT_URIS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	// Backwards compatible single value.
	const single = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
	if (single) multi.push(single);

	return unique(multi);
}

function buildRequestRedirectUri(req) {
	if (!req) return null;
	// Note: trust proxy is enabled in production in app.js.
	const host = (req.get('host') || '').trim();
	if (!host) return null;
	const base = (typeof req.adminBasePath === 'string') ? req.adminBasePath : (process.env.ADMIN_PATH_PREFIX || '/admin');
	return `${req.protocol}://${host}${base || ''}/google/callback`;
}

function resolveRedirectUri({ req, storedRedirectUri }) {
	const candidates = unique([storedRedirectUri, ...getConfiguredRedirectUris()]);
	if (!candidates.length) return null;

	const requested = buildRequestRedirectUri(req);
	if (requested && candidates.includes(requested)) return requested;

	// Fallback to first configured value.
	return candidates[0];
}

async function getStoredOAuthConfig() {
	const { rows } = await pool.query(
		`SELECT id, client_id, client_secret, redirect_uri, access_token, refresh_token, scope, token_type, expiry_date
		 FROM google_oauth_tokens
		 ORDER BY updated_at DESC
		 LIMIT 1`
	);
	return rows[0] || null;
}

function buildOAuthClient({ clientId, clientSecret, redirectUri }) {
	return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getOAuthClient() {
	// Preference order: DB stored config -> env
	const stored = await getStoredOAuthConfig();
	const clientId = stored?.client_id || process.env.GOOGLE_CLIENT_ID;
	const clientSecret = stored?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
	const redirectUri = stored?.redirect_uri || getConfiguredRedirectUris()[0];

	if (!clientId || !clientSecret || !redirectUri) return null;

	const oAuth2Client = buildOAuthClient({ clientId, clientSecret, redirectUri });

	const accessToken = stored?.access_token;
	const refreshToken = stored?.refresh_token;
	const expiryDate = stored?.expiry_date;

	if (accessToken || refreshToken) {
		oAuth2Client.setCredentials({
			access_token: accessToken || undefined,
			refresh_token: refreshToken || undefined,
			expiry_date: expiryDate || undefined,
		});
	}

	// Persist refreshed tokens
	oAuth2Client.on('tokens', async (tokens) => {
		try {
			await pool.query(
				`INSERT INTO google_oauth_tokens (client_id, client_secret, redirect_uri, access_token, refresh_token, scope, token_type, expiry_date)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				[
					clientId,
					clientSecret,
					redirectUri,
					tokens.access_token || stored?.access_token || null,
					tokens.refresh_token || stored?.refresh_token || null,
					tokens.scope || stored?.scope || null,
					tokens.token_type || stored?.token_type || null,
					tokens.expiry_date || stored?.expiry_date || null,
				]
			);
		} catch (err) {
			console.warn('[google] token persist failed:', err.message);
		}
	});

	return oAuth2Client;
}

async function getCalendarClient() {
	const auth = await getOAuthClient();
	if (!auth) return null;
	return google.calendar({ version: 'v3', auth });
}

async function getStaffCalendarId(staffId) {
	const { rows } = await pool.query(
		`SELECT google_calendar_id
		 FROM staff
		 WHERE id = $1`,
		[staffId]
	);
	return rows[0]?.google_calendar_id || null;
}

function isAccessError(err) {
	const code = err?.code || err?.response?.status;
	return code === 401 || code === 403 || code === 404;
}

function isMissingGoogleAuthError(err) {
	const msg = String(err?.message || err?.response?.data?.error?.message || '').toLowerCase();
	return msg.includes('no access, refresh token') || msg.includes('no access') && msg.includes('refresh token');
}

async function getCalendarIdsForStaffIds(staffIds) {
	const ids = Array.isArray(staffIds) ? staffIds.filter(Boolean) : [];
	const calendarIds = [];
	for (const staffId of ids) {
		const calId = await getStaffCalendarId(staffId);
		if (calId) calendarIds.push(calId);
	}
	calendarIds.push('primary');
	return unique(calendarIds);
}

async function getAuthUrl(req) {
	const stored = await getStoredOAuthConfig();
	const clientId = stored?.client_id || process.env.GOOGLE_CLIENT_ID;
	const clientSecret = stored?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
	const redirectUri = resolveRedirectUri({ req, storedRedirectUri: stored?.redirect_uri });
	if (!clientId || !clientSecret || !redirectUri) return null;

	const oAuth2Client = buildOAuthClient({ clientId, clientSecret, redirectUri });
	return oAuth2Client.generateAuthUrl({
		access_type: 'offline',
		prompt: 'consent',
		scope: ['https://www.googleapis.com/auth/calendar'],
	});
}

async function handleOAuthCallback(code, req) {
	const stored = await getStoredOAuthConfig();
	const clientId = stored?.client_id || process.env.GOOGLE_CLIENT_ID;
	const clientSecret = stored?.client_secret || process.env.GOOGLE_CLIENT_SECRET;
	const redirectUri = resolveRedirectUri({ req, storedRedirectUri: stored?.redirect_uri });
	if (!clientId || !clientSecret || !redirectUri) throw new Error('Google OAuth config missing');

	const oAuth2Client = buildOAuthClient({ clientId, clientSecret, redirectUri });
	const { tokens } = await oAuth2Client.getToken(code);

	await pool.query(
		`INSERT INTO google_oauth_tokens (client_id, client_secret, redirect_uri, access_token, refresh_token, scope, token_type, expiry_date)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		[
			clientId,
			clientSecret,
			redirectUri,
			tokens.access_token || null,
			tokens.refresh_token || null,
			tokens.scope || null,
			tokens.token_type || null,
			tokens.expiry_date || null,
		]
	);

	return true;
}

async function isStaffBusy({ staffId, startsAt, endsAt }) {
	const calendar = await getCalendarClient();
	if (!calendar) return false;

	const staffCalendarId = await getStaffCalendarId(staffId);
	const calendarIdsToTry = [staffCalendarId, 'primary'].filter((v, i, a) => v && a.indexOf(v) === i);
	if (!calendarIdsToTry.length) return false;

	for (const calendarId of calendarIdsToTry) {
		try {
			const resp = await calendar.freebusy.query({
				requestBody: {
					timeMin: startsAt.toISOString(),
					timeMax: endsAt.toISOString(),
					items: [{ id: calendarId }],
				},
			});

			const busy = resp?.data?.calendars?.[calendarId]?.busy || [];
			return busy.length > 0;
		} catch (err) {
			// If staff calendar id is wrong/unshared, fall back to primary.
			if (calendarId !== 'primary' && isAccessError(err)) continue;
			return false;
		}
	}

	return false;
}

async function createEventForAppointment({ staffId, startsAt, endsAt, summary, description }) {
	if (!staffId) return null;
	const calendar = await getCalendarClient();
	if (!calendar) return null;

	const staffCalendarId = await getStaffCalendarId(staffId);
	const calendarIdsToTry = [staffCalendarId, 'primary'].filter((v, i, a) => v && a.indexOf(v) === i);
	if (!calendarIdsToTry.length) return null;

	let lastErr = null;
	for (const calendarId of calendarIdsToTry) {
		try {
			const resp = await calendar.events.insert({
				calendarId,
				requestBody: {
					summary,
					description,
					start: { dateTime: startsAt.toISOString() },
					end: { dateTime: endsAt.toISOString() },
				},
			});

			return resp?.data?.id || null;
		} catch (err) {
			lastErr = err;
			if (calendarId !== 'primary' && isAccessError(err)) continue;
			break;
		}
	}

	if (lastErr) {
		const code = lastErr?.code || lastErr?.response?.status;
		const msg = lastErr?.message || lastErr?.response?.data?.error?.message || 'unknown error';
		console.warn('[google] event insert failed:', code, msg);
		if (isMissingGoogleAuthError(lastErr)) {
			console.warn(
				'[google] OAuth kimlik bilgileri eksik/yenilenemiyor. Admin > Google Entegrasyonu ekranından yeniden bağlayın; refresh_token gelmiyorsa Google hesabında uygulama erişimini kaldırıp tekrar consent verin.'
			);
		}
	}
	return null;
}

async function updateEventForAppointment({ eventId, staffIds, startsAt, endsAt, summary, description }) {
	if (!eventId) return false;
	const calendar = await getCalendarClient();
	if (!calendar) return false;

	const calendarIdsToTry = await getCalendarIdsForStaffIds(staffIds);
	let lastErr = null;
	for (const calendarId of calendarIdsToTry) {
		try {
			await calendar.events.patch({
				calendarId,
				eventId,
				requestBody: {
					summary,
					description,
					start: { dateTime: startsAt.toISOString() },
					end: { dateTime: endsAt.toISOString() },
				},
			});
			return true;
		} catch (err) {
			lastErr = err;
			if (calendarId !== 'primary' && isAccessError(err)) continue;
			break;
		}
	}

	if (lastErr) {
		const code = lastErr?.code || lastErr?.response?.status;
		const msg = lastErr?.message || lastErr?.response?.data?.error?.message || 'unknown error';
		console.warn('[google] event update failed:', code, msg);
	}
	return false;
}

async function deleteEventForAppointment({ eventId, staffIds }) {
	if (!eventId) return false;
	const calendar = await getCalendarClient();
	if (!calendar) return false;

	const calendarIdsToTry = await getCalendarIdsForStaffIds(staffIds);
	let lastErr = null;
	for (const calendarId of calendarIdsToTry) {
		try {
			await calendar.events.delete({ calendarId, eventId });
			return true;
		} catch (err) {
			lastErr = err;
			// Treat already deleted as success.
			const code = err?.code || err?.response?.status;
			if (code === 404) return true;
			if (calendarId !== 'primary' && isAccessError(err)) continue;
			break;
		}
	}

	if (lastErr) {
		const code = lastErr?.code || lastErr?.response?.status;
		const msg = lastErr?.message || lastErr?.response?.data?.error?.message || 'unknown error';
		console.warn('[google] event delete failed:', code, msg);
	}
	return false;
}

module.exports = {
	getAuthUrl,
	handleOAuthCallback,
	isStaffBusy,
	createEventForAppointment,
	updateEventForAppointment,
	deleteEventForAppointment,
};
