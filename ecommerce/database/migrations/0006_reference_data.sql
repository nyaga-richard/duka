-- =============================================================================
-- 0006 reference data. Kept in a migration because the application refuses to
-- boot without order statuses, permissions and shipping methods.
-- No customer, product, order or payment sample data is seeded here.
-- =============================================================================

INSERT INTO "order_status" ("order_status_id", "status_name") VALUES
  (1, 'cart'),
  (2, 'placed'),
  (3, 'paid'),
  (4, 'processing'),
  (5, 'shipped'),
  (6, 'delivered'),
  (7, 'cancelled'),
  (8, 'refunded'),
  (9, 'payment_failed');
SELECT setval(pg_get_serial_sequence('"order_status"', 'order_status_id'),
              (SELECT max("order_status_id") FROM "order_status"));

INSERT INTO "payment_type" ("payment_type_id", "type_name") VALUES
  (1, 'card'),
  (2, 'mpesa'),
  (3, 'cash_on_delivery'),
  (4, 'bank_transfer');
SELECT setval(pg_get_serial_sequence('"payment_type"', 'payment_type_id'),
              (SELECT max("payment_type_id") FROM "payment_type"));

INSERT INTO "shipping_method" ("shipping_method_id", "method_name", "price", "code", "min_days", "max_days") VALUES
  (1, 'Nairobi standard delivery', 300.00, 'nairobi-standard', 1, 2),
  (2, 'Countrywide courier', 500.00, 'countrywide', 2, 5),
  (3, 'Pickup at store', 0.00, 'pickup', 0, 0);
SELECT setval(pg_get_serial_sequence('"shipping_method"', 'shipping_method_id'),
              (SELECT max("shipping_method_id") FROM "shipping_method"));

INSERT INTO "country" ("country_id", "country_name") VALUES (1, 'Kenya');
SELECT setval(pg_get_serial_sequence('"country"', 'country_id'),
              (SELECT max("country_id") FROM "country"));

INSERT INTO "admin_permission" ("permission_code", "description") VALUES
  ('orders.read', 'View orders, customers and payment state'),
  ('orders.write', 'Change order status, cancel orders and record fulfilment'),
  ('catalog.read', 'View catalogue, products and variants'),
  ('catalog.write', 'Create and edit catalogue content and prices'),
  ('inventory.read', 'View stock levels, reservations and movements'),
  ('inventory.write', 'Adjust stock and release reservations'),
  ('payments.read', 'View payment transactions and webhooks'),
  ('payments.write', 'Record or reconcile payments'),
  ('refunds.write', 'Request and approve refunds'),
  ('shipments.write', 'Create shipments and update tracking'),
  ('customers.read', 'View customer accounts and addresses'),
  ('sync.manage', 'Run and inspect ERP synchronisation'),
  ('audit.read', 'Read audit and security logs'),
  ('settings.manage', 'Change store settings');

INSERT INTO "admin_role" ("role_id", "role_name", "description", "is_system") VALUES
  (1, 'owner', 'Full access including settings and audit', true),
  (2, 'operations', 'Day-to-day order, fulfilment and ERP operations', true),
  (3, 'support', 'Read-mostly customer support access', true),
  (4, 'auditor', 'Read-only access for audit and reconciliation', true);
SELECT setval(pg_get_serial_sequence('"admin_role"', 'role_id'),
              (SELECT max("role_id") FROM "admin_role"));

INSERT INTO "admin_role_permission" ("role_id", "permission_code")
SELECT 1, "permission_code" FROM "admin_permission";

INSERT INTO "admin_role_permission" ("role_id", "permission_code") VALUES
  (2, 'orders.read'), (2, 'orders.write'), (2, 'catalog.read'), (2, 'catalog.write'),
  (2, 'inventory.read'), (2, 'inventory.write'), (2, 'payments.read'), (2, 'payments.write'),
  (2, 'refunds.write'), (2, 'shipments.write'), (2, 'customers.read'), (2, 'sync.manage'),
  (3, 'orders.read'), (3, 'catalog.read'), (3, 'customers.read'), (3, 'payments.read'),
  (4, 'orders.read'), (4, 'payments.read'), (4, 'inventory.read'), (4, 'audit.read');

INSERT INTO "app_setting" ("key", "value") VALUES
  ('store', '{"name":"Duka Store","currency":"KES","country":"KE","support_email":null}'::jsonb),
  ('payments', '{"mode":"manual","capture_enabled":false}'::jsonb),
  ('erp', '{"enabled":false,"reserve_orders":false,"default_branch_id":null,"default_warehouse_id":null}'::jsonb),
  ('storefront', '{"page_size":24,"allow_guest_checkout":true,"require_phone":true}'::jsonb);
