const { pool } = require('../config/db');

const DEFAULT_TZ = 'Europe/Istanbul';

async function getTodayRevenueTotals({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT (now() AT TIME ZONE $1)::date AS today_local
		),
		shop AS (
			SELECT
				COALESCE(
					SUM(
						CASE
							WHEN o.payment_status IN ('paid', 'partial_refunded', 'refunded')
								THEN (o.total_amount - COALESCE(o.refunded_amount, 0))
							ELSE 0
						END
					),
					0
				)::numeric(12, 2) AS shop_revenue
			FROM orders o
			WHERE (o.created_at AT TIME ZONE $1)::date = (SELECT today_local FROM params)
		),
		appt AS (
			SELECT
				COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appointment_revenue
			FROM appointments a
			JOIN appointment_services aps ON aps.appointment_id = a.id
			JOIN services sv ON sv.id = aps.service_id
			WHERE a.status = 'completed'
				AND (a.ends_at AT TIME ZONE $1)::date = (SELECT today_local FROM params)
		)
		SELECT
			(SELECT shop_revenue FROM shop) AS shop_revenue_today,
			(SELECT appointment_revenue FROM appt) AS appointment_revenue_today,
			((SELECT shop_revenue FROM shop) + (SELECT appointment_revenue FROM appt))::numeric(12, 2) AS total_revenue_today;`,
		[tz]
	);

	return rows[0] || {
		shop_revenue_today: 0,
		appointment_revenue_today: 0,
		total_revenue_today: 0,
	};
}

async function getTodayAppointmentRevenue({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT (now() AT TIME ZONE $1)::date AS today_local
		)
		SELECT
			COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appointment_revenue_today
		FROM appointments a
		JOIN appointment_services aps ON aps.appointment_id = a.id
		JOIN services sv ON sv.id = aps.service_id
		WHERE a.status = 'completed'
			AND (a.ends_at AT TIME ZONE $1)::date = (SELECT today_local FROM params);`,
		[tz]
	);

	return rows[0] || { appointment_revenue_today: 0 };
}

async function getThisMonthRevenueTotals({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				date_trunc('month', now() AT TIME ZONE $1) AS month_start_local,
				date_trunc('month', (now() AT TIME ZONE $1) + interval '1 month') AS next_month_start_local
		),
		shop AS (
			SELECT
				COALESCE(
					SUM(
						CASE
							WHEN o.payment_status IN ('paid', 'partial_refunded', 'refunded')
								THEN (o.total_amount - COALESCE(o.refunded_amount, 0))
							ELSE 0
						END
					),
					0
				)::numeric(12, 2) AS shop_revenue
			FROM orders o
			WHERE (o.created_at AT TIME ZONE $1) >= (SELECT month_start_local FROM params)
				AND (o.created_at AT TIME ZONE $1) < (SELECT next_month_start_local FROM params)
		),
		appt AS (
			SELECT
				COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appointment_revenue
			FROM appointments a
			JOIN appointment_services aps ON aps.appointment_id = a.id
			JOIN services sv ON sv.id = aps.service_id
			WHERE a.status = 'completed'
				AND (a.ends_at AT TIME ZONE $1) >= (SELECT month_start_local FROM params)
				AND (a.ends_at AT TIME ZONE $1) < (SELECT next_month_start_local FROM params)
		)
		SELECT
			(SELECT shop_revenue FROM shop) AS shop_revenue_month,
			(SELECT appointment_revenue FROM appt) AS appointment_revenue_month,
			((SELECT shop_revenue FROM shop) + (SELECT appointment_revenue FROM appt))::numeric(12, 2) AS total_revenue_month;`,
		[tz]
	);

	return rows[0] || {
		shop_revenue_month: 0,
		appointment_revenue_month: 0,
		total_revenue_month: 0,
	};
}

async function getThisMonthAppointmentRevenue({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				date_trunc('month', now() AT TIME ZONE $1) AS month_start_local,
				date_trunc('month', (now() AT TIME ZONE $1) + interval '1 month') AS next_month_start_local
		)
		SELECT
			COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appointment_revenue_month
		FROM appointments a
		JOIN appointment_services aps ON aps.appointment_id = a.id
		JOIN services sv ON sv.id = aps.service_id
		WHERE a.status = 'completed'
			AND (a.ends_at AT TIME ZONE $1) >= (SELECT month_start_local FROM params)
			AND (a.ends_at AT TIME ZONE $1) < (SELECT next_month_start_local FROM params);`,
		[tz]
	);

	return rows[0] || { appointment_revenue_month: 0 };
}

async function getStaffOfTheMonth({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				date_trunc('month', now() AT TIME ZONE $1) AS month_start_local,
				date_trunc('month', (now() AT TIME ZONE $1) + interval '1 month') AS next_month_start_local
		)
		SELECT
			s.id AS staff_id,
			s.full_name AS staff_full_name,
			COUNT(*)::int AS appointments_count
		FROM appointments a
		JOIN staff s ON s.id = a.staff_id
		WHERE a.staff_id IS NOT NULL
			AND a.status IN ('booked','completed','no_show')
			AND (a.starts_at AT TIME ZONE $1) >= (SELECT month_start_local FROM params)
			AND (a.starts_at AT TIME ZONE $1) < (SELECT next_month_start_local FROM params)
		GROUP BY s.id, s.full_name
		ORDER BY appointments_count DESC, s.full_name ASC
		LIMIT 1;`,
		[tz]
	);

	return rows[0] || null;
}

async function listTopProducts({ limit = 5 } = {}) {
	const lim = Math.max(1, Math.min(50, Number(limit) || 5));
	const { rows } = await pool.query(
		`SELECT
			p.id AS product_id,
			p.name AS product_name,
			COALESCE(SUM(oi.quantity), 0)::int AS sold_quantity,
			COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)::numeric(12, 2) AS revenue
		FROM order_items oi
		JOIN orders o ON o.id = oi.order_id
		LEFT JOIN products p ON p.id = oi.product_id
		WHERE o.status IN ('shipped','completed')
		GROUP BY p.id, p.name
		ORDER BY sold_quantity DESC, revenue DESC NULLS LAST
		LIMIT $1;`,
		[lim]
	);
	return rows;
}

async function getLast7DaysRevenueSeries({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				(now() AT TIME ZONE $1)::date AS today_local,
				((now() AT TIME ZONE $1)::date - 6) AS start_date
		),
		days AS (
			SELECT generate_series(
				(SELECT start_date FROM params),
				(SELECT today_local FROM params),
				interval '1 day'
			)::date AS d
		),
		shop AS (
			SELECT
				(o.created_at AT TIME ZONE $1)::date AS d,
				COALESCE(
					SUM(
						CASE
							WHEN o.payment_status IN ('paid', 'partial_refunded', 'refunded')
								THEN (o.total_amount - COALESCE(o.refunded_amount, 0))
							ELSE 0
						END
					),
					0
				)::numeric(12, 2) AS shop_rev
			FROM orders o
			WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN (SELECT start_date FROM params) AND (SELECT today_local FROM params)
			GROUP BY 1
		),
		appt AS (
			SELECT
				(a.ends_at AT TIME ZONE $1)::date AS d,
				COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appt_rev
			FROM appointments a
			JOIN appointment_services aps ON aps.appointment_id = a.id
			JOIN services sv ON sv.id = aps.service_id
			WHERE a.status = 'completed'
				AND (a.ends_at AT TIME ZONE $1)::date BETWEEN (SELECT start_date FROM params) AND (SELECT today_local FROM params)
			GROUP BY 1
		)
		SELECT
			days.d AS date,
			(COALESCE(shop.shop_rev, 0) + COALESCE(appt.appt_rev, 0))::numeric(12, 2) AS revenue
		FROM days
		LEFT JOIN shop ON shop.d = days.d
		LEFT JOIN appt ON appt.d = days.d
		ORDER BY days.d ASC;`,
		[tz]
	);

	return rows;
}

async function getLast7DaysAppointmentRevenueSeries({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				(now() AT TIME ZONE $1)::date AS today_local,
				((now() AT TIME ZONE $1)::date - 6) AS start_date
		),
		days AS (
			SELECT generate_series(
				(SELECT start_date FROM params),
				(SELECT today_local FROM params),
				interval '1 day'
			)::date AS d
		),
		appt AS (
			SELECT
				(a.ends_at AT TIME ZONE $1)::date AS d,
				COALESCE(SUM((sv.price_cents * aps.quantity) / 100.0), 0)::numeric(12, 2) AS appt_rev
			FROM appointments a
			JOIN appointment_services aps ON aps.appointment_id = a.id
			JOIN services sv ON sv.id = aps.service_id
			WHERE a.status = 'completed'
				AND (a.ends_at AT TIME ZONE $1)::date BETWEEN (SELECT start_date FROM params) AND (SELECT today_local FROM params)
			GROUP BY 1
		)
		SELECT
			days.d AS date,
			COALESCE(appt.appt_rev, 0)::numeric(12, 2) AS revenue
		FROM days
		LEFT JOIN appt ON appt.d = days.d
		ORDER BY days.d ASC;`,
		[tz]
	);

	return rows;
}

async function getLast7DaysShopRevenueSeries({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				(now() AT TIME ZONE $1)::date AS today_local,
				((now() AT TIME ZONE $1)::date - 6) AS start_date
		),
		days AS (
			SELECT generate_series(
				(SELECT start_date FROM params),
				(SELECT today_local FROM params),
				interval '1 day'
			)::date AS d
		),
		shop AS (
			SELECT
				(o.created_at AT TIME ZONE $1)::date AS d,
				COALESCE(
					SUM(
						CASE
							WHEN o.payment_status IN ('paid', 'partial_refunded', 'refunded')
								THEN (o.total_amount - COALESCE(o.refunded_amount, 0))
							ELSE 0
						END
					),
					0
				)::numeric(12, 2) AS shop_rev
			FROM orders o
			WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN (SELECT start_date FROM params) AND (SELECT today_local FROM params)
			GROUP BY 1
		)
		SELECT
			days.d AS date,
			COALESCE(shop.shop_rev, 0)::numeric(12, 2) AS revenue
		FROM days
		LEFT JOIN shop ON shop.d = days.d
		ORDER BY days.d ASC;`,
		[tz]
	);

	return rows;
}

async function getTodayAppointmentOccupancy({ tz = DEFAULT_TZ, slotMinutes = 30 } = {}) {
	const slot = Math.max(5, Math.min(240, Number(slotMinutes) || 30));

	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				(now() AT TIME ZONE $1)::date AS today_local,
				EXTRACT(ISODOW FROM (now() AT TIME ZONE $1))::int - 1 AS dow_tr
		),
		hours AS (
			SELECT
				bh.category,
				bh.is_closed,
				bh.start_time,
				bh.end_time
			FROM business_hours bh
			WHERE bh.day_of_week = (SELECT dow_tr FROM params)
			UNION ALL
			SELECT
				o.category,
				o.is_closed,
				o.start_time,
				o.end_time
			FROM business_day_overrides o
			WHERE o.date = (SELECT today_local FROM params)
		),
		effective_hours AS (
			SELECT DISTINCT ON (category)
				category,
				is_closed,
				start_time,
				end_time
			FROM hours
			ORDER BY category, (CASE WHEN (SELECT today_local FROM params) = (SELECT today_local FROM params) THEN 1 ELSE 0 END) DESC
		),
		staff_counts AS (
			SELECT
				SUM(CASE WHEN is_active AND category IN ('men','both') THEN 1 ELSE 0 END)::int AS staff_men,
				SUM(CASE WHEN is_active AND category IN ('women','both') THEN 1 ELSE 0 END)::int AS staff_women
			FROM staff
		),
		open_minutes AS (
			SELECT
				COALESCE(SUM(
					CASE
						WHEN eh.is_closed THEN 0
						WHEN eh.category = 'men' THEN EXTRACT(EPOCH FROM (eh.end_time - eh.start_time)) / 60.0 * (SELECT staff_men FROM staff_counts)
						WHEN eh.category = 'women' THEN EXTRACT(EPOCH FROM (eh.end_time - eh.start_time)) / 60.0 * (SELECT staff_women FROM staff_counts)
						ELSE 0
					END
				), 0)::numeric AS available_minutes
			FROM effective_hours eh
		),
		booked AS (
			SELECT
				COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60.0), 0)::numeric AS booked_minutes
			FROM appointments a
			WHERE a.status = 'booked'
				AND (a.starts_at AT TIME ZONE $1)::date = (SELECT today_local FROM params)
		)
		SELECT
			(SELECT available_minutes FROM open_minutes) AS available_minutes,
			(SELECT booked_minutes FROM booked) AS booked_minutes,
			GREATEST(FLOOR((SELECT available_minutes FROM open_minutes) / $2), 0)::int AS capacity_slots,
			GREATEST(CEIL((SELECT booked_minutes FROM booked) / $2), 0)::int AS booked_slots;`,
		[tz, slot]
	);

	const row = rows[0] || {};
	const capacitySlots = Number(row.capacity_slots) || 0;
	const bookedSlots = Math.min(Number(row.booked_slots) || 0, capacitySlots || Number(row.booked_slots) || 0);

	return {
		slot_minutes: slot,
		available_minutes: Number(row.available_minutes) || 0,
		booked_minutes: Number(row.booked_minutes) || 0,
		capacity_slots: capacitySlots,
		booked_slots: bookedSlots,
		free_slots: Math.max(0, capacitySlots - bookedSlots),
	};
}

async function getShopThisMonthRevenue({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH params AS (
			SELECT
				date_trunc('month', now() AT TIME ZONE $1) AS month_start_local,
				date_trunc('month', (now() AT TIME ZONE $1) + interval '1 month') AS next_month_start_local
		)
		SELECT
			COALESCE(
				SUM(
					CASE
						WHEN o.payment_status IN ('paid', 'partial_refunded', 'refunded')
							THEN (o.total_amount - COALESCE(o.refunded_amount, 0))
						ELSE 0
					END
				),
				0
			)::numeric(12, 2) AS shop_revenue_month
		FROM orders o
		WHERE (o.created_at AT TIME ZONE $1) >= (SELECT month_start_local FROM params)
			AND (o.created_at AT TIME ZONE $1) < (SELECT next_month_start_local FROM params);`,
		[tz]
	);
	return rows[0] || { shop_revenue_month: 0 };
}

// =====================================================
// PAYMENT REPORTS
// =====================================================

async function getPaymentReport({ startDate, endDate, tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH date_range AS (
			SELECT 
				COALESCE($2::date, (now() AT TIME ZONE $1)::date - 30) AS start_d,
				COALESCE($3::date, (now() AT TIME ZONE $1)::date) AS end_d
		)
		SELECT
			COUNT(*)::int AS total_orders,
			COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders,
			COUNT(*) FILTER (WHERE payment_status = 'failed')::int AS failed_orders,
			COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS pending_orders,
			COUNT(*) FILTER (WHERE payment_status IN ('partial_refunded', 'refunded'))::int AS refunded_orders,
			COALESCE(SUM(total_amount) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS total_revenue,
			COALESCE(SUM(refunded_amount), 0)::numeric(12, 2) AS total_refunded,
			COALESCE(SUM(total_amount - COALESCE(refunded_amount, 0)) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS net_revenue,
			COALESCE(AVG(total_amount) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS avg_order_value
		FROM orders o, date_range dr
		WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN dr.start_d AND dr.end_d`,
		[tz, startDate || null, endDate || null]
	);
	return rows[0] || {};
}

async function getDailyPaymentSeries({ startDate, endDate, tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`WITH date_range AS (
			SELECT 
				COALESCE($2::date, (now() AT TIME ZONE $1)::date - 30) AS start_d,
				COALESCE($3::date, (now() AT TIME ZONE $1)::date) AS end_d
		),
		days AS (
			SELECT generate_series(
				(SELECT start_d FROM date_range),
				(SELECT end_d FROM date_range),
				interval '1 day'
			)::date AS d
		),
		daily AS (
			SELECT
				(o.created_at AT TIME ZONE $1)::date AS d,
				COUNT(*)::int AS orders,
				COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
				COUNT(*) FILTER (WHERE payment_status = 'failed')::int AS failed,
				COALESCE(SUM(total_amount) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS revenue,
				COALESCE(SUM(refunded_amount), 0)::numeric(12, 2) AS refunded
			FROM orders o, date_range dr
			WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN dr.start_d AND dr.end_d
			GROUP BY 1
		)
		SELECT
			days.d AS date,
			COALESCE(daily.orders, 0) AS orders,
			COALESCE(daily.paid, 0) AS paid,
			COALESCE(daily.failed, 0) AS failed,
			COALESCE(daily.revenue, 0) AS revenue,
			COALESCE(daily.refunded, 0) AS refunded
		FROM days
		LEFT JOIN daily ON daily.d = days.d
		ORDER BY days.d ASC`,
		[tz, startDate || null, endDate || null]
	);
	return rows;
}

async function getPaymentMethodStats({ startDate, endDate, tz = DEFAULT_TZ } = {}) {
	// Note: This is a placeholder - actual payment method tracking would need to be added
	// Currently returns aggregated payment stats
	const { rows } = await pool.query(
		`WITH date_range AS (
			SELECT 
				COALESCE($2::date, (now() AT TIME ZONE $1)::date - 30) AS start_d,
				COALESCE($3::date, (now() AT TIME ZONE $1)::date) AS end_d
		)
		SELECT
			'iyzico' AS payment_method,
			COUNT(*)::int AS transactions,
			COALESCE(SUM(total_amount) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS total_amount,
			COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS successful,
			COUNT(*) FILTER (WHERE payment_status = 'failed')::int AS failed,
			CASE 
				WHEN COUNT(*) > 0 
				THEN ROUND((COUNT(*) FILTER (WHERE payment_status = 'paid')::numeric / COUNT(*)::numeric) * 100, 2)
				ELSE 0 
			END AS success_rate
		FROM orders o, date_range dr
		WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN dr.start_d AND dr.end_d
			AND payment_status IS NOT NULL`,
		[tz, startDate || null, endDate || null]
	);
	return rows;
}

// =====================================================
// ADVANCED ANALYTICS
// =====================================================

async function getCustomerStats({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`SELECT
			COUNT(DISTINCT u.id)::int AS total_customers,
			COUNT(DISTINCT u.id) FILTER (WHERE u.created_at > now() - interval '30 days')::int AS new_customers_30d,
			COUNT(DISTINCT o.shop_user_id)::int AS customers_with_orders,
			COALESCE(AVG(order_count), 0)::numeric(5, 2) AS avg_orders_per_customer
		FROM users u
		LEFT JOIN (
			SELECT shop_user_id, COUNT(*)::int AS order_count
			FROM orders
			WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')
			GROUP BY shop_user_id
		) o ON o.shop_user_id = u.id`,
		[]
	);
	return rows[0] || {};
}

async function getTopCustomers({ limit = 10, tz = DEFAULT_TZ } = {}) {
	const lim = Math.max(1, Math.min(50, Number(limit) || 10));
	const { rows } = await pool.query(
		`SELECT
			u.id AS customer_id,
			u.full_name AS customer_name,
			u.email AS customer_email,
			COUNT(o.id)::int AS order_count,
			COALESCE(SUM(o.total_amount - COALESCE(o.refunded_amount, 0)), 0)::numeric(12, 2) AS total_spent,
			MAX(o.created_at) AS last_order_at
		FROM users u
		JOIN orders o ON o.shop_user_id = u.id
		WHERE o.payment_status IN ('paid', 'partial_refunded', 'refunded')
		GROUP BY u.id, u.full_name, u.email
		ORDER BY total_spent DESC
		LIMIT $1`,
		[lim]
	);
	return rows;
}

async function getCategoryStats({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`SELECT
			c.id AS category_id,
			c.name AS category_name,
			COUNT(DISTINCT oi.order_id)::int AS order_count,
			COALESCE(SUM(oi.quantity), 0)::int AS items_sold,
			COALESCE(SUM(oi.quantity * oi.price_at_purchase), 0)::numeric(12, 2) AS revenue
		FROM categories c
		LEFT JOIN products p ON p.category_id = c.id
		LEFT JOIN order_items oi ON oi.product_id = p.id
		LEFT JOIN orders o ON o.id = oi.order_id AND o.payment_status IN ('paid', 'partial_refunded', 'refunded')
		GROUP BY c.id, c.name
		ORDER BY revenue DESC NULLS LAST`,
		[]
	);
	return rows;
}

async function getHourlyOrderDistribution({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`SELECT
			EXTRACT(HOUR FROM (created_at AT TIME ZONE $1))::int AS hour,
			COUNT(*)::int AS order_count,
			COALESCE(SUM(total_amount) FILTER (WHERE payment_status IN ('paid', 'partial_refunded', 'refunded')), 0)::numeric(12, 2) AS revenue
		FROM orders
		WHERE created_at > now() - interval '30 days'
		GROUP BY 1
		ORDER BY 1`,
		[tz]
	);
	return rows;
}

async function getConversionFunnel({ tz = DEFAULT_TZ } = {}) {
	const { rows } = await pool.query(
		`SELECT
			(SELECT COUNT(DISTINCT user_id) FROM cart WHERE updated_at > now() - interval '30 days')::int AS carts_created,
			(SELECT COUNT(*) FROM orders WHERE created_at > now() - interval '30 days')::int AS orders_attempted,
			(SELECT COUNT(*) FROM orders WHERE created_at > now() - interval '30 days' AND payment_status = 'paid')::int AS orders_completed,
			(SELECT COUNT(*) FROM orders WHERE created_at > now() - interval '30 days' AND payment_status = 'failed')::int AS orders_failed`,
		[]
	);
	return rows[0] || {};
}

async function getInventoryAlerts({ threshold = 5 } = {}) {
	const { rows } = await pool.query(
		`SELECT
			p.id AS product_id,
			p.name AS product_name,
			p.stock AS total_stock,
			p.low_stock_threshold,
			COALESCE(
				(SELECT SUM(pv.stock) FROM product_variants pv WHERE pv.product_id = p.id),
				p.stock
			)::int AS available_stock,
			CASE 
				WHEN p.stock <= 0 THEN 'out_of_stock'
				WHEN p.stock <= p.low_stock_threshold THEN 'low_stock'
				ELSE 'in_stock'
			END AS status
		FROM products p
		WHERE p.is_active = true
			AND p.stock <= GREATEST(p.low_stock_threshold, $1)
		ORDER BY p.stock ASC, p.name ASC`,
		[threshold]
	);
	return rows;
}

module.exports = {
	getTodayRevenueTotals,
	getTodayAppointmentRevenue,
	getThisMonthRevenueTotals,
	getThisMonthAppointmentRevenue,
	getStaffOfTheMonth,
	listTopProducts,
	getLast7DaysRevenueSeries,
	getLast7DaysAppointmentRevenueSeries,
	getLast7DaysShopRevenueSeries,
	getTodayAppointmentOccupancy,
	getShopThisMonthRevenue,
	// Payment reports
	getPaymentReport,
	getDailyPaymentSeries,
	getPaymentMethodStats,
	// Advanced analytics
	getCustomerStats,
	getTopCustomers,
	getCategoryStats,
	getHourlyOrderDistribution,
	getConversionFunnel,
	getInventoryAlerts,
};
