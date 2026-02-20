const { pool } = require('../config/db');

function isMissingColumnError(err, columnName) {
	return Boolean(
		err &&
		(err.code === '42703' || /column\s+"[^"]+"\s+does\s+not\s+exist/i.test(String(err.message || ''))) &&
		String(err.message || '').toLowerCase().includes(String(columnName).toLowerCase())
	);
}

async function findOverlappingAppointments({ staffId, startsAt, endsAt }) {
	const { rows } = await pool.query(
		`SELECT id, starts_at, ends_at, status
		 FROM appointments
		 WHERE staff_id = $1
			AND status IN ('booked')
			AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
		 LIMIT 1`,
		[staffId, startsAt, endsAt]
	);
	return rows[0] || null;
}

async function createCustomerIfNeeded({ fullName, phone, email }) {
	// Best-effort retention: upsert by phone/email when provided.
	const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
	const normalizedPhone = String(phone).trim();

	// Prefer phone if present
	const { rows } = await pool.query(
		`INSERT INTO customers (full_name, phone, email)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (phone)
		 DO UPDATE SET full_name = EXCLUDED.full_name, email = COALESCE(EXCLUDED.email, customers.email), updated_at = now()
		 RETURNING id`,
		[fullName, normalizedPhone, normalizedEmail]
	);
	return rows[0].id;
}

async function createAppointment({
	category,
	serviceIds,
	staffId,
	startsAt,
	endsAt,
	customerFullName,
	customerPhone,
	customerEmail,
	notes,
	googleEventId,
}) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');

		const customerId = await (async () => {
			try {
				return await createCustomerIfNeeded({
					fullName: customerFullName,
					phone: customerPhone,
					email: customerEmail,
				});
			} catch {
				return null;
			}
		})();

		const { rows } = await client.query(
			`INSERT INTO appointments (
				category, customer_id, customer_full_name, customer_phone, customer_email,
				staff_id, starts_at, ends_at, status, notes, google_event_id
			)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'booked',$9,$10)
			RETURNING id`,
			[
				category,
				customerId,
				customerFullName,
				customerPhone,
				customerEmail || null,
				staffId || null,
				startsAt,
				endsAt,
				notes || null,
				googleEventId || null,
			]
		);

		const appointmentId = rows[0].id;

		for (const serviceId of serviceIds) {
			await client.query(
				`INSERT INTO appointment_services (appointment_id, service_id, quantity)
				 VALUES ($1, $2, 1)
				 ON CONFLICT DO NOTHING`,
				[appointmentId, serviceId]
			);
		}

		await client.query('COMMIT');
		return appointmentId;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		client.release();
	}
}

async function listUpcomingAppointments(limit = 20) {
	const { rows } = await pool.query(
		`SELECT a.id, a.starts_at, a.ends_at, a.status, a.customer_full_name, a.customer_phone,
			a.category,
			s.full_name AS staff_full_name
		 FROM appointments a
		 LEFT JOIN staff s ON s.id = a.staff_id
		 WHERE a.status = 'booked' AND a.starts_at >= now()
		 ORDER BY a.starts_at ASC
		 LIMIT $1`,
		[limit]
	);
	return rows;
}

async function listAppointmentsInRange({ start, end, category, staffId = null, includePast = false }) {
	const params = [start, end];
	let where = `a.starts_at >= $1 AND a.starts_at < $2`;

	if (category) {
		params.push(category);
		where += ` AND a.category = $${params.length}`;
	}

	if (staffId) {
		params.push(staffId);
		where += ` AND a.staff_id = $${params.length}`;
	}

	// Default: active calendar shows booked only. List view can opt-in to include past.
	if (includePast) {
		where += ` AND a.status IN ('booked','completed','cancelled','no_show')`;
	} else {
		where += ` AND a.status = 'booked'`;
	}

	const { rows } = await pool.query(
		`SELECT
			a.id,
			a.category,
			a.starts_at,
			a.ends_at,
			a.status,
			a.customer_full_name,
			a.customer_phone,
			a.customer_email,
			a.notes,
			a.staff_id,
			a.google_event_id,
			s.full_name AS staff_full_name,
			COALESCE(
				json_agg(
					json_build_object(
						'id', sv.id,
						'name', sv.name,
						'durationMinutes', sv.duration_minutes,
						'priceCents', sv.price_cents,
						'category', sv.category
					)
					ORDER BY sv.name
				) FILTER (WHERE sv.id IS NOT NULL),
				'[]'::json
			) AS services
		FROM appointments a
		LEFT JOIN staff s ON s.id = a.staff_id
		LEFT JOIN appointment_services aps ON aps.appointment_id = a.id
		LEFT JOIN services sv ON sv.id = aps.service_id
		WHERE ${where}
		GROUP BY a.id, s.full_name
		ORDER BY a.starts_at ASC`,
		params
	);

	return rows;
}

async function getAppointmentById(id) {
	const { rows } = await pool.query(
		`SELECT
			a.id,
			a.category,
			a.starts_at,
			a.ends_at,
			a.status,
			a.customer_full_name,
			a.customer_phone,
			a.customer_email,
			a.notes,
			a.staff_id,
			a.google_event_id,
			s.full_name AS staff_full_name,
			COALESCE(
				json_agg(
					json_build_object(
						'id', sv.id,
						'name', sv.name,
						'durationMinutes', sv.duration_minutes,
						'priceCents', sv.price_cents,
						'category', sv.category
					)
					ORDER BY sv.name
				) FILTER (WHERE sv.id IS NOT NULL),
				'[]'::json
			) AS services
		FROM appointments a
		LEFT JOIN staff s ON s.id = a.staff_id
		LEFT JOIN appointment_services aps ON aps.appointment_id = a.id
		LEFT JOIN services sv ON sv.id = aps.service_id
		WHERE a.id = $1
		GROUP BY a.id, s.full_name`,
		[id]
	);
	return rows[0] || null;
}

async function updateAppointment({
	appointmentId,
	staffId,
	startsAt,
	endsAt,
	customerFullName,
	customerPhone,
	customerEmail,
	notes,
}) {
	const { rows } = await pool.query(
		`UPDATE appointments
		 SET
			staff_id = $2,
			starts_at = $3,
			ends_at = $4,
			customer_full_name = $5,
			customer_phone = $6,
			customer_email = $7,
			notes = $8,
			updated_at = now()
		 WHERE id = $1 AND status = 'booked'
		 RETURNING id, category, staff_id, starts_at, ends_at, status, google_event_id`,
		[
			appointmentId,
			staffId || null,
			startsAt,
			endsAt,
			customerFullName,
			customerPhone,
			customerEmail || null,
			notes || null,
		]
	);
	return rows[0] || null;
}

async function cancelAppointment({ appointmentId, cancelReason }) {
	try {
		const { rows } = await pool.query(
			`UPDATE appointments
			 SET
				status = 'cancelled',
				cancelled_at = now(),
				cancel_reason = $2,
				updated_at = now()
			 WHERE id = $1 AND status = 'booked'
			 RETURNING id, category, staff_id, starts_at, ends_at, status, google_event_id`,
			[appointmentId, cancelReason ? String(cancelReason).trim() : null]
		);
		return rows[0] || null;
	} catch (err) {
		// Backward compatible if DB isn't migrated yet.
		if (isMissingColumnError(err, 'cancel_reason') || isMissingColumnError(err, 'cancelled_at')) {
			const { rows } = await pool.query(
				`UPDATE appointments
				 SET status = 'cancelled', updated_at = now()
				 WHERE id = $1 AND status = 'booked'
				 RETURNING id, category, staff_id, starts_at, ends_at, status, google_event_id`,
				[appointmentId]
			);
			return rows[0] || null;
		}
		throw err;
	}
}

async function markCompletedEndedAppointments() {
	const { rowCount } = await pool.query(
		`UPDATE appointments
		 SET status = 'completed', updated_at = now()
		 WHERE status = 'booked' AND ends_at < now()`
	);
	return rowCount;
}

async function deletePastAppointmentsOlderThan(daysToKeep = 14) {
	const { rowCount } = await pool.query(
		`DELETE FROM appointments
		 WHERE
			ends_at < now() - ($1::int * interval '1 day')
			AND status IN ('completed','cancelled','no_show')`,
		[daysToKeep]
	);
	return rowCount;
}

async function setGoogleEventId({ appointmentId, googleEventId }) {
	if (!appointmentId) return;
	await pool.query(
		`UPDATE appointments
		 SET google_event_id = $2, updated_at = now()
		 WHERE id = $1`,
		[appointmentId, googleEventId || null]
	);
}

async function listAppointmentsNeedingReminder({ limit = 50 } = {}) {
	try {
		const { rows } = await pool.query(
			`SELECT id
			 FROM appointments
			 WHERE
				status = 'booked'
				AND customer_email IS NOT NULL
				AND reminder_sent_at IS NULL
				AND starts_at >= now() + interval '23 hours'
				AND starts_at <  now() + interval '24 hours'
			 ORDER BY starts_at ASC
			 LIMIT $1`,
			[limit]
		);
		return rows.map((r) => r.id);
	} catch (err) {
		if (isMissingColumnError(err, 'reminder_sent_at')) {
			// Bubble up: caller can decide to disable reminders gracefully.
			throw err;
		}
		throw err;
	}
}

async function markReminderSent({ appointmentId }) {
	if (!appointmentId) return;
	await pool.query(
		`UPDATE appointments
		 SET reminder_sent_at = now(), updated_at = now()
		 WHERE id = $1`,
		[appointmentId]
	);
}

module.exports = {
	findOverlappingAppointments,
	createAppointment,
	setGoogleEventId,
	listUpcomingAppointments,
	listAppointmentsInRange,
	getAppointmentById,
	updateAppointment,
	cancelAppointment,
	markCompletedEndedAppointments,
	deletePastAppointmentsOlderThan,
	listAppointmentsNeedingReminder,
	markReminderSent,
};
