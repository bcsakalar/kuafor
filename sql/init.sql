-- Core schema for Unisex Beauty Salon & Barber Shop
-- Comments: English. UI is handled in EJS.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Optional enum-ish constraints are done via CHECK for simplicity.

CREATE TABLE IF NOT EXISTS admins (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	full_name text,
	role text NOT NULL DEFAULT 'admin',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	full_name text NOT NULL,
	phone text,
	email text,
	category text NOT NULL CHECK (category IN ('men', 'women', 'both')),
	google_calendar_id text,
	is_active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
	price_cents integer NOT NULL CHECK (price_cents >= 0),
	category text NOT NULL CHECK (category IN ('men', 'women')),
	is_active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	full_name text,
	phone text,
	email text,
	notes text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (email),
	UNIQUE (phone)
);

CREATE TABLE IF NOT EXISTS appointments (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	category text NOT NULL CHECK (category IN ('men', 'women')),
	customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
	customer_full_name text NOT NULL,
	customer_phone text NOT NULL,
	customer_email text,
	staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
	starts_at timestamptz NOT NULL,
	ends_at timestamptz NOT NULL,
	status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
	google_event_id text,
	reminder_sent_at timestamptz,
	cancelled_at timestamptz,
	cancel_reason text,
	notes text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CHECK (ends_at > starts_at)
);

-- Backfill/migrate existing databases safely.
ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS google_event_id text;

ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS notes text;

-- Prevent overlapping booked appointments for the same staff member.
-- Allows overlaps when staff_id is NULL (unassigned).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'appointments_no_overlap_booked'
	) THEN
		ALTER TABLE appointments
			ADD CONSTRAINT appointments_no_overlap_booked
			EXCLUDE USING gist (
				staff_id WITH =,
				tstzrange(starts_at, ends_at, '[)') WITH &&
			)
			WHERE (status = 'booked' AND staff_id IS NOT NULL);
	END IF;
END
$$;

-- Many-to-many: an appointment can have multiple services.
CREATE TABLE IF NOT EXISTS appointment_services (
	appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
	service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
	quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
	PRIMARY KEY (appointment_id, service_id)
);

-- Store business rules configurable from admin panel.
CREATE TABLE IF NOT EXISTS settings (
	key text PRIMARY KEY,
	value jsonb NOT NULL,
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- ETBIS / E-commerce legal company info fields.
-- We keep the existing key/value JSON settings model and extend the table with optional columns.
-- These columns are intended to be stored on a single row: settings.key = 'company'.
ALTER TABLE settings
	ADD COLUMN IF NOT EXISTS company_name text,
	ADD COLUMN IF NOT EXISTS tax_office text,
	ADD COLUMN IF NOT EXISTS tax_number text,
	ADD COLUMN IF NOT EXISTS mersis_number text,
	ADD COLUMN IF NOT EXISTS kep_address text,
	ADD COLUMN IF NOT EXISTS trade_registry_number text,
	ADD COLUMN IF NOT EXISTS contact_address text,
	ADD COLUMN IF NOT EXISTS contact_phone text,
	ADD COLUMN IF NOT EXISTS contact_email text,
	ADD COLUMN IF NOT EXISTS representative_name text;

-- Basic schedule config per staff (optional). If not present, use global settings.
CREATE TABLE IF NOT EXISTS staff_working_hours (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
	day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
	start_time time NOT NULL,
	end_time time NOT NULL,
	break_start time,
	break_end time,
	is_closed boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (staff_id, day_of_week)
);

-- Global business working hours per branch/category.
-- day_of_week: 0=Mon .. 6=Sun (TR style)
CREATE TABLE IF NOT EXISTS business_hours (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	category text NOT NULL CHECK (category IN ('men', 'women')),
	day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
	start_time time NOT NULL,
	end_time time NOT NULL,
	is_closed boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (category, day_of_week),
	CHECK (end_time > start_time)
);

-- Date-specific overrides: full-day holiday (is_closed=true) or half-day/custom hours.
CREATE TABLE IF NOT EXISTS business_day_overrides (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	category text NOT NULL CHECK (category IN ('men', 'women')),
	date date NOT NULL,
	start_time time NOT NULL,
	end_time time NOT NULL,
	is_closed boolean NOT NULL DEFAULT false,
	note text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (category, date),
	CHECK (end_time > start_time)
);

-- Store Google OAuth credentials/tokens per admin (starter version: single row).
CREATE TABLE IF NOT EXISTS google_oauth_tokens (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	client_id text,
	client_secret text,
	redirect_uri text,
	access_token text,
	refresh_token text,
	scope text,
	token_type text,
	expiry_date bigint,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- Session store table for connect-pg-simple
CREATE TABLE IF NOT EXISTS "sessions" (
	sid varchar NOT NULL COLLATE "default",
	sess json NOT NULL,
	expire timestamptz(6) NOT NULL,
	CONSTRAINT "session_pkey" PRIMARY KEY (sid)
);

-- =============================================================
-- Shop (E-commerce) module
-- Notes:
-- - Uses same DB and session store.
-- - "orders.user_id" references existing "customers" table because
--   this project does not currently have a dedicated "users" table.
-- =============================================================

CREATE TABLE IF NOT EXISTS categories (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	slug text NOT NULL,
	UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS products (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	description text,
	price numeric(12, 2) NOT NULL CHECK (price >= 0),
	stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
	low_stock_threshold integer NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
	image_url text,
	category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
	is_active boolean NOT NULL DEFAULT true,
	size_options text[],
	color_options text[],
	-- If true, stock is managed per size and shared across all colors.
	-- UI still renders color choices, but selecting any color consumes the same shared stock.
	share_stock_across_colors boolean NOT NULL DEFAULT false,
	-- If true, price is managed per size and shared across all colors.
	-- Variant prices will be kept in sync across colors for the same size.
	share_price_across_colors boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Variant-level stock for selectable options (size/color).
-- variant_key uses JSON.stringify([selected_size, selected_color]) to keep consistency
-- with cart_items.variant_key and order_items.variant_key.
CREATE TABLE IF NOT EXISTS product_variants (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
	variant_key text NOT NULL,
	selected_size text,
	selected_color text,
	price numeric(12, 2) CHECK (price >= 0),
	stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (product_id, variant_key)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id
	ON product_variants (product_id);

-- Backfill/migrate existing databases safely.
ALTER TABLE product_variants
	ADD COLUMN IF NOT EXISTS price numeric(12, 2);

-- Backfill/migrate existing databases safely.
ALTER TABLE products
	ADD COLUMN IF NOT EXISTS low_stock_threshold integer NOT NULL DEFAULT 5;

-- Product volume/size label (e.g., '150 ml'). Nullable.
ALTER TABLE products
	ADD COLUMN IF NOT EXISTS size text;

-- Product selectable options (nullable). When present, customer can choose.
ALTER TABLE products
	ADD COLUMN IF NOT EXISTS size_options text[];

ALTER TABLE products
	ADD COLUMN IF NOT EXISTS color_options text[];

ALTER TABLE products
	ADD COLUMN IF NOT EXISTS share_stock_across_colors boolean NOT NULL DEFAULT false;

ALTER TABLE products
	ADD COLUMN IF NOT EXISTS share_price_across_colors boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS orders (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid REFERENCES customers(id) ON DELETE SET NULL,
	shop_user_id uuid,
	customer_full_name text,
	customer_phone text,
	customer_email text,
	tracking_code text,
	payment_token text,
	payment_id text,
	payment_status text NOT NULL DEFAULT 'pending',
	refund_in_progress boolean NOT NULL DEFAULT false,
	refunded_amount numeric(12, 2) NOT NULL DEFAULT 0,
	refunded_at timestamptz,
	payment_items jsonb,
	payment_error_code text,
	payment_error_message text,
	payment_error_group text,
	payment_error_raw jsonb,
	payment_error_at timestamptz,
	total_amount numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
	status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'shipped', 'completed', 'cancelled')),
	shipping_address text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill/migrate existing databases safely.
ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS tracking_code text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS shop_user_id uuid;

-- Snapshot customer contact details on the order itself.
-- This prevents later customer profile updates (or dedupe merges) from affecting historical orders.
ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS customer_full_name text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS customer_phone text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS customer_email text;

-- Best-effort backfill for existing orders (keeps order data stable going forward).
UPDATE orders o
SET
	customer_full_name = COALESCE(o.customer_full_name, cu.full_name),
	customer_phone = COALESCE(o.customer_phone, cu.phone),
	customer_email = COALESCE(o.customer_email, cu.email)
FROM customers cu
WHERE o.user_id = cu.id
	AND (
		o.customer_full_name IS NULL
		OR o.customer_phone IS NULL
		OR o.customer_email IS NULL
	);

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_token text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_id text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending';

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS refund_in_progress boolean NOT NULL DEFAULT false;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS refunded_amount numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_items jsonb;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_error_code text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_error_message text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_error_group text;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_error_raw jsonb;

ALTER TABLE orders
	ADD COLUMN IF NOT EXISTS payment_error_at timestamptz;

DO $$
BEGIN
	-- Keep this constraint up-to-date as payment lifecycle evolves.
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'orders_payment_status_check'
	) THEN
		ALTER TABLE orders
			DROP CONSTRAINT orders_payment_status_check;
	END IF;

	ALTER TABLE orders
		ADD CONSTRAINT orders_payment_status_check
		CHECK (payment_status IN ('pending', 'paid', 'failed', 'partial_refunded', 'refunded'));
END
$$;

-- Refund ledger (per payment transaction).
CREATE TABLE IF NOT EXISTS order_refunds (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
	payment_transaction_id text NOT NULL,
	amount numeric(12, 2) NOT NULL CHECK (amount > 0),
	currency text NOT NULL DEFAULT 'TRY',
	status text NOT NULL CHECK (status IN ('requested', 'success', 'failure')),
	iyzico_refund_id text,
	error_message text,
	raw_response jsonb,
	created_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_refunds_order_created_at
	ON order_refunds (order_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_tracking_code_unique
	ON orders (tracking_code)
	WHERE tracking_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
	product_id uuid REFERENCES products(id) ON DELETE SET NULL,
	quantity integer NOT NULL CHECK (quantity > 0),
	price_at_purchase numeric(12, 2) NOT NULL CHECK (price_at_purchase >= 0),
	selected_size text,
	selected_color text,
	variant_key text NOT NULL DEFAULT ''
);

-- Backfill/migrate existing databases safely.
ALTER TABLE order_items
	ADD COLUMN IF NOT EXISTS selected_size text;

ALTER TABLE order_items
	ADD COLUMN IF NOT EXISTS selected_color text;

ALTER TABLE order_items
	ADD COLUMN IF NOT EXISTS variant_key text NOT NULL DEFAULT '';

-- Stock movement log (order decreases, manual adjustments, etc.)
CREATE TABLE IF NOT EXISTS product_stock_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	product_id uuid REFERENCES products(id) ON DELETE SET NULL,
	order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
	delta integer NOT NULL,
	reason text NOT NULL CHECK (reason IN ('order', 'manual', 'order_cancel_customer', 'iyzico_payment', 'order_cancel_admin_refund')),
	variant_key text,
	selected_size text,
	selected_color text,
	changed_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill/migrate existing databases safely.
ALTER TABLE product_stock_events
	ADD COLUMN IF NOT EXISTS variant_key text;

ALTER TABLE product_stock_events
	ADD COLUMN IF NOT EXISTS selected_size text;

ALTER TABLE product_stock_events
	ADD COLUMN IF NOT EXISTS selected_color text;

-- Backwards compatible update: extend stock event reasons.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'product_stock_events_reason_check'
	) THEN
		ALTER TABLE product_stock_events
			DROP CONSTRAINT product_stock_events_reason_check;
		ALTER TABLE product_stock_events
			ADD CONSTRAINT product_stock_events_reason_check
			CHECK (reason IN ('order', 'manual', 'order_cancel_customer', 'iyzico_payment', 'order_cancel_admin_refund'));
	END IF;
END
$$;

-- Status history for ShopAdmin order tracking.
CREATE TABLE IF NOT EXISTS order_status_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
	status text NOT NULL CHECK (status IN ('pending', 'shipped', 'completed', 'cancelled')),
	changed_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Payment status history for Shop/ShopAdmin timelines.
CREATE TABLE IF NOT EXISTS order_payment_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
	status text NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'partial_refunded', 'refunded')),
	changed_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Customer cancellation requests (for paid but not-yet-shipped orders)
-- Notes:
-- - Customers can request cancellation while status='pending'
-- - Admin can approve (typically cancel + refund) or reject
CREATE TABLE IF NOT EXISTS order_cancellation_requests (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
	requested_by_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
	requested_by_shop_user_id uuid,
	status text NOT NULL DEFAULT 'requested'
		CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
	customer_note text,
	admin_note text,
	processed_by_admin_id uuid REFERENCES admins(id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	processed_at timestamptz
);

-- Prevent multiple open requests per order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_cancel_requests_order_open_unique
	ON order_cancellation_requests (order_id)
	WHERE status = 'requested';

CREATE INDEX IF NOT EXISTS idx_order_cancel_requests_status_created_at
	ON order_cancellation_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories (slug);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products (category_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products (is_active);
CREATE INDEX IF NOT EXISTS idx_orders_user_created_at ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_shop_user_created_at ON orders (shop_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_events_order_created_at ON order_status_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_payment_events_order_created_at ON order_payment_events (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_stock_events_product_created_at ON product_stock_events (product_id, created_at DESC);

-- =============================================================
-- Public Contact (main site /iletisim)
-- Notes:
-- - Stores contact messages submitted from the main public site.
-- - View/manage from Admin panel.
-- =============================================================

CREATE TABLE IF NOT EXISTS public_contact_messages (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	full_name text,
	email text NOT NULL,
	subject text,
	message text NOT NULL,
	status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
	created_ip text,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_public_contact_messages_status_created_at
	ON public_contact_messages (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_public_contact_messages_email_created_at
	ON public_contact_messages (email, created_at DESC);

-- =============================================================
-- Shop Contact (shop.localhost:/iletisim)
-- Notes:
-- - Stores contact/support messages submitted from the Shop UI.
-- - View/manage from ShopAdmin.
-- =============================================================

-- Ensure users table exists before any FK references.
CREATE TABLE IF NOT EXISTS users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email text NOT NULL UNIQUE,
	password_hash text,
	full_name text,
	phone text,
	auth_provider text NOT NULL DEFAULT 'local',
	google_sub text,
	role text NOT NULL DEFAULT 'customer',
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_contact_messages (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	shop_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
	full_name text,
	email text NOT NULL,
	phone text,
	subject text,
	message text NOT NULL,
	status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived')),
	created_ip text,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_contact_messages_status_created_at
	ON shop_contact_messages (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_contact_messages_email_created_at
	ON shop_contact_messages (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_contact_messages_shop_user_created_at
	ON shop_contact_messages (shop_user_id, created_at DESC);

-- =============================================================
-- Shop Auth + DB-backed Cart
-- Notes:
-- - This is for the e-commerce module only.
-- - Booking/appointments remain guest-friendly.
-- =============================================================

CREATE TABLE IF NOT EXISTS users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email text NOT NULL UNIQUE,
	password_hash text,
	full_name text,
	phone text,
	auth_provider text NOT NULL DEFAULT 'local',
	google_sub text,
	role text NOT NULL DEFAULT 'customer',
	created_at timestamptz NOT NULL DEFAULT now()
);

-- Backwards compatible updates for existing DBs
ALTER TABLE users
	ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'local';

ALTER TABLE users
	ADD COLUMN IF NOT EXISTS google_sub text;

DO $$
BEGIN
	-- Make password_hash nullable for OAuth users.
	IF EXISTS (
		SELECT 1
		FROM information_schema.columns
		WHERE table_name = 'users'
			AND column_name = 'password_hash'
			AND is_nullable = 'NO'
	) THEN
		ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
	END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
	ON users (google_sub)
	WHERE google_sub IS NOT NULL;

-- Link orders back to authenticated shop users (optional; supports cart cleanup & account ownership checks).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'orders_shop_user_id_fkey'
	) THEN
		ALTER TABLE orders
			ADD CONSTRAINT orders_shop_user_id_fkey
			FOREIGN KEY (shop_user_id) REFERENCES users(id) ON DELETE SET NULL;
	END IF;
END
$$;

-- Link cancellation requests back to authenticated shop users (optional).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'order_cancel_requests_shop_user_id_fkey'
	) THEN
		ALTER TABLE order_cancellation_requests
			ADD CONSTRAINT order_cancel_requests_shop_user_id_fkey
			FOREIGN KEY (requested_by_shop_user_id) REFERENCES users(id) ON DELETE SET NULL;
	END IF;
END
$$;

-- Password reset tokens (Shop auth)
-- Security notes:
-- - Store only a hash of the token (never the raw token)
-- - Enforce expiration and one-time use
CREATE TABLE IF NOT EXISTS password_resets (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	used_at timestamptz,
	requested_ip text,
	user_agent text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_created_at
	ON password_resets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at
	ON password_resets (expires_at);

CREATE TABLE IF NOT EXISTS cart (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cart_items (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	cart_id uuid NOT NULL REFERENCES cart(id) ON DELETE CASCADE,
	product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
	selected_size text,
	selected_color text,
	variant_key text NOT NULL DEFAULT '',
	quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 50),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (cart_id, product_id, variant_key)
);

-- Backfill/migrate existing databases safely.
ALTER TABLE cart_items
	ADD COLUMN IF NOT EXISTS selected_size text;

ALTER TABLE cart_items
	ADD COLUMN IF NOT EXISTS selected_color text;

ALTER TABLE cart_items
	ADD COLUMN IF NOT EXISTS variant_key text NOT NULL DEFAULT '';

-- Ensure deleting a product cleans up active carts.
-- Existing DBs may have ON DELETE RESTRICT from older versions.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'cart_items_product_id_fkey'
	) THEN
		ALTER TABLE cart_items
			DROP CONSTRAINT cart_items_product_id_fkey;
	END IF;

	ALTER TABLE cart_items
		ADD CONSTRAINT cart_items_product_id_fkey
		FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE;
END
$$;

-- Upgrade cart uniqueness to include variant_key.
DO $$
BEGIN
	-- Default implicit unique constraint name for (cart_id, product_id)
	IF EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'cart_items_cart_id_product_id_key'
	) THEN
		ALTER TABLE cart_items
			DROP CONSTRAINT cart_items_cart_id_product_id_key;
	END IF;

	-- Ensure variant-aware uniqueness.
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'cart_items_unique_variant'
	) THEN
		ALTER TABLE cart_items
			ADD CONSTRAINT cart_items_unique_variant
			UNIQUE (cart_id, product_id, variant_key);
	END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_cart_user_id ON cart (user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id ON cart_items (cart_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_product_id ON cart_items (product_id);

-- Seed sample shop data (DEV friendly)
-- Safe to run multiple times:
-- - categories upsert by slug
-- - products are inserted only if table is empty
-- Seed disabled: categories will be managed via admin.

-- Seed disabled: products will be created via admin.

CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments (starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_starts_at ON appointments (staff_id, starts_at);

-- Seed a couple of services (editable in admin later)
-- Seed disabled: services will be created via admin.

-- Default business hours (editable from Admin > Ayarlar)
-- Mon-Sat: 09:00-20:00, Sun: 10:00-18:00
-- Seed disabled: business hours will be configured via admin.

-- Admin user is created at first startup from ADMIN_EMAIL / ADMIN_PASSWORD env vars.
-- See .env.example for details.

COMMIT;
