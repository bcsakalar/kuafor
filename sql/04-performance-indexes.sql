-- Performance Indexes for Production
-- Run this migration to add critical indexes for query optimization

BEGIN;

-- =====================================================
-- E-COMMERCE / SHOP INDEXES
-- =====================================================

-- Orders: shop_user_id for customer order listing
CREATE INDEX IF NOT EXISTS idx_orders_shop_user_id 
	ON orders (shop_user_id) 
	WHERE shop_user_id IS NOT NULL;

-- Orders: tracking_code for order tracking lookups
CREATE INDEX IF NOT EXISTS idx_orders_tracking_code_lookup 
	ON orders (tracking_code) 
	WHERE tracking_code IS NOT NULL;

-- Orders: payment_status for payment filtering
CREATE INDEX IF NOT EXISTS idx_orders_payment_status 
	ON orders (payment_status);

-- Orders: combined index for admin order listing
CREATE INDEX IF NOT EXISTS idx_orders_status_payment_created 
	ON orders (status, payment_status, created_at DESC);

-- Order items: order lookup
CREATE INDEX IF NOT EXISTS idx_order_items_order_id_product 
	ON order_items (order_id, product_id);

-- Products: active products with category
CREATE INDEX IF NOT EXISTS idx_products_active_category 
	ON products (is_active, category_id) 
	WHERE is_active = true;

-- Product variants: product lookup with stock
CREATE INDEX IF NOT EXISTS idx_product_variants_product_stock 
	ON product_variants (product_id, stock);

-- Cart items: cart lookup
CREATE INDEX IF NOT EXISTS idx_cart_items_cart_product_variant 
	ON cart_items (cart_id, product_id, variant_key);

-- =====================================================
-- BOOKING / APPOINTMENT INDEXES
-- =====================================================

-- Appointments: staff + date range for availability
CREATE INDEX IF NOT EXISTS idx_appointments_staff_time_range 
	ON appointments (staff_id, starts_at, ends_at) 
	WHERE status = 'booked';

-- Appointments: category + date for listing
CREATE INDEX IF NOT EXISTS idx_appointments_category_starts 
	ON appointments (category, starts_at DESC);

-- Appointments: customer phone for lookup
CREATE INDEX IF NOT EXISTS idx_appointments_customer_phone 
	ON appointments (customer_phone);

-- Appointments: customer email for lookup
CREATE INDEX IF NOT EXISTS idx_appointments_customer_email 
	ON appointments (customer_email) 
	WHERE customer_email IS NOT NULL;

-- Appointments: reminder scheduling
CREATE INDEX IF NOT EXISTS idx_appointments_reminder 
	ON appointments (reminder_sent_at, starts_at) 
	WHERE status = 'booked' AND reminder_sent_at IS NULL;

-- Staff: active staff by category
CREATE INDEX IF NOT EXISTS idx_staff_active_category 
	ON staff (is_active, category) 
	WHERE is_active = true;

-- Services: active services by category
CREATE INDEX IF NOT EXISTS idx_services_active_category 
	ON services (is_active, category) 
	WHERE is_active = true;

-- Business hours: day lookup
CREATE INDEX IF NOT EXISTS idx_business_hours_category_day 
	ON business_hours (category, day_of_week);

-- Business day overrides: date lookup
CREATE INDEX IF NOT EXISTS idx_business_day_overrides_category_date 
	ON business_day_overrides (category, date);

-- =====================================================
-- USER / AUTH INDEXES
-- =====================================================

-- Users: Google OAuth lookup
CREATE INDEX IF NOT EXISTS idx_users_google_sub_lookup 
	ON users (google_sub) 
	WHERE google_sub IS NOT NULL;

-- Users: email lookup (already unique, but add btree for pattern matching)
CREATE INDEX IF NOT EXISTS idx_users_email_lower 
	ON users (LOWER(email));

-- Sessions: expire for cleanup
CREATE INDEX IF NOT EXISTS idx_sessions_expire 
	ON sessions (expire);

-- Password resets: token lookup
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash 
	ON password_resets (token_hash);

-- Password resets: user + created for listing
CREATE INDEX IF NOT EXISTS idx_password_resets_user_created 
	ON password_resets (user_id, created_at DESC);

-- =====================================================
-- CONTACT / MESSAGES INDEXES
-- =====================================================

-- Public contact: status + created for admin listing
CREATE INDEX IF NOT EXISTS idx_public_contact_status_created 
	ON public_contact_messages (status, created_at DESC);

-- Shop contact: shop_user for customer history
CREATE INDEX IF NOT EXISTS idx_shop_contact_user_created 
	ON shop_contact_messages (shop_user_id, created_at DESC) 
	WHERE shop_user_id IS NOT NULL;

-- =====================================================
-- ANALYTICS / REPORTING INDEXES
-- =====================================================

-- Orders: created_at for date range queries
CREATE INDEX IF NOT EXISTS idx_orders_created_at 
	ON orders (created_at DESC);

-- Appointments: ends_at for completed revenue
CREATE INDEX IF NOT EXISTS idx_appointments_ends_at 
	ON appointments (ends_at DESC);

-- Order items: product revenue aggregation
CREATE INDEX IF NOT EXISTS idx_order_items_product_revenue 
	ON order_items (product_id, quantity, price_at_purchase);

-- Stock events: product history
CREATE INDEX IF NOT EXISTS idx_stock_events_product_created 
	ON product_stock_events (product_id, created_at DESC);

-- =====================================================
-- CANCELLATION / REFUND INDEXES
-- =====================================================

-- Cancellation requests: status for admin listing
CREATE INDEX IF NOT EXISTS idx_cancel_requests_status_created 
	ON order_cancellation_requests (status, created_at DESC);

-- Order refunds: order lookup
CREATE INDEX IF NOT EXISTS idx_order_refunds_order_id 
	ON order_refunds (order_id);

-- Order status events: timeline
CREATE INDEX IF NOT EXISTS idx_order_status_timeline 
	ON order_status_events (order_id, created_at DESC);

-- Order payment events: timeline
CREATE INDEX IF NOT EXISTS idx_order_payment_timeline 
	ON order_payment_events (order_id, created_at DESC);

COMMIT;
