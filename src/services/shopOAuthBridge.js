const crypto = require('crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;

const states = new Map();
const tickets = new Map();

function now() {
	return Date.now();
}

function cleanup(map, ttlMs) {
	const t = now();
	for (const [key, value] of map.entries()) {
		if (!value || !value.createdAt || (t - value.createdAt) > ttlMs) {
			map.delete(key);
		}
	}
}

function createState({ nextUrl, shopOrigin }) {
	cleanup(states, STATE_TTL_MS);
	const state = crypto.randomBytes(16).toString('hex');
	states.set(state, {
		nextUrl: String(nextUrl || '').trim() || '/',
		shopOrigin: String(shopOrigin || '').trim(),
		createdAt: now(),
	});
	return state;
}

function consumeState(state) {
	cleanup(states, STATE_TTL_MS);
	const key = String(state || '').trim();
	if (!key) return null;
	const value = states.get(key) || null;
	if (value) states.delete(key);
	return value;
}

function createTicket({ userId, nextUrl }) {
	cleanup(tickets, TICKET_TTL_MS);
	const ticket = crypto.randomBytes(24).toString('hex');
	tickets.set(ticket, {
		userId: String(userId || '').trim(),
		nextUrl: String(nextUrl || '').trim() || '/',
		createdAt: now(),
	});
	return ticket;
}

function consumeTicket(ticket) {
	cleanup(tickets, TICKET_TTL_MS);
	const key = String(ticket || '').trim();
	if (!key) return null;
	const value = tickets.get(key) || null;
	if (value) tickets.delete(key);
	return value;
}

module.exports = {
	createState,
	consumeState,
	createTicket,
	consumeTicket,
};
