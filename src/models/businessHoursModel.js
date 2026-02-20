const { pool } = require('../config/db');

function toDowMon0(date) {
	// JS: Sun=0..Sat=6 -> Mon=0..Sun=6
	return (date.getDay() + 6) % 7;
}

function parseTimeToParts(timeStr) {
	// Accept HH:MM or HH:MM:SS
	const s = String(timeStr || '').trim();
	const [hh, mm] = s.split(':');
	return { hours: Number(hh), minutes: Number(mm) };
}

async function getWeeklyHoursByCategory(category) {
	const { rows } = await pool.query(
		`SELECT category, day_of_week, start_time::text AS start_time, end_time::text AS end_time, is_closed
		 FROM business_hours
		 WHERE category = $1
		 ORDER BY day_of_week ASC`,
		[category]
	);
	return rows;
}

async function upsertWeeklyHours(category, days) {
	// days: [{ dayOfWeek, isClosed, startTime, endTime }]
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		for (const d of days) {
			const dayOfWeek = Number(d.dayOfWeek);
			const isClosed = Boolean(d.isClosed);
			const startTime = String(d.startTime || '09:00');
			const endTime = String(d.endTime || '20:00');

			await client.query(
				`INSERT INTO business_hours (category, day_of_week, start_time, end_time, is_closed)
				 VALUES ($1,$2,$3,$4,$5)
				 ON CONFLICT (category, day_of_week)
				 DO UPDATE SET
					start_time = EXCLUDED.start_time,
					end_time = EXCLUDED.end_time,
					is_closed = EXCLUDED.is_closed,
					updated_at = now()`,
				[category, dayOfWeek, startTime, endTime, isClosed]
			);
		}
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
}

async function listOverrides(category, fromDate = null, toDate = null) {
	const params = [category];
	let where = 'WHERE category = $1';
	if (fromDate) {
		params.push(fromDate);
		where += ` AND date >= $${params.length}`;
	}
	if (toDate) {
		params.push(toDate);
		where += ` AND date <= $${params.length}`;
	}

	const { rows } = await pool.query(
		`SELECT id, category, date::text AS date, start_time::text AS start_time, end_time::text AS end_time, is_closed, note
		 FROM business_day_overrides
		 ${where}
		 ORDER BY date ASC`,
		params
	);
	return rows;
}

async function upsertOverride({ category, date, isClosed, startTime, endTime, note }) {
	const { rows } = await pool.query(
		`INSERT INTO business_day_overrides (category, date, start_time, end_time, is_closed, note)
		 VALUES ($1,$2,$3,$4,$5,$6)
		 ON CONFLICT (category, date)
		 DO UPDATE SET
			start_time = EXCLUDED.start_time,
			end_time = EXCLUDED.end_time,
			is_closed = EXCLUDED.is_closed,
			note = EXCLUDED.note,
			updated_at = now()
		 RETURNING id`,
		[category, date, startTime, endTime, Boolean(isClosed), note || null]
	);
	return rows[0]?.id || null;
}

async function deleteOverride(id) {
	await pool.query('DELETE FROM business_day_overrides WHERE id = $1', [id]);
}

async function getEffectiveHours({ category, dateStr }) {
	// dateStr: YYYY-MM-DD (local date key)
	const { rows: overrideRows } = await pool.query(
		`SELECT is_closed, start_time::text AS start_time, end_time::text AS end_time
		 FROM business_day_overrides
		 WHERE category = $1 AND date = $2`,
		[category, dateStr]
	);

	if (overrideRows[0]) {
		return {
			isClosed: Boolean(overrideRows[0].is_closed),
			startTime: overrideRows[0].start_time,
			endTime: overrideRows[0].end_time,
			source: 'override',
		};
	}

	const date = (() => {
		const [y, m, d] = String(dateStr).split('-').map((x) => Number(x));
		return new Date(y, m - 1, d);
	})();
	const dayOfWeek = toDowMon0(date);

	const { rows: weeklyRows } = await pool.query(
		`SELECT is_closed, start_time::text AS start_time, end_time::text AS end_time
		 FROM business_hours
		 WHERE category = $1 AND day_of_week = $2`,
		[category, dayOfWeek]
	);

	if (!weeklyRows[0]) return null;

	return {
		isClosed: Boolean(weeklyRows[0].is_closed),
		startTime: weeklyRows[0].start_time,
		endTime: weeklyRows[0].end_time,
		source: 'weekly',
	};
}

module.exports = {
	parseTimeToParts,
	getWeeklyHoursByCategory,
	upsertWeeklyHours,
	listOverrides,
	upsertOverride,
	deleteOverride,
	getEffectiveHours,
};
