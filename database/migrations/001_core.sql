-- Duka Business OS. Forward-only, checksummed migration. PostgreSQL 17.
CREATE TABLE companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, currency char(3) NOT NULL DEFAULT 'KES',
 timezone text NOT NULL DEFAULT 'Africa/Nairobi', tax_pin text, address text, phone text, email text,
 settings jsonb NOT NULL DEFAULT '{"receiptFooter":"Thank you for shopping with us.","receiptWidth":80,"allowCredit":true,"maxDiscountPercent":"10","fiscalRequired":false}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
 email text NOT NULL UNIQUE CHECK(email=lower(email)), name text NOT NULL, password_hash text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','inactive')),
 mfa_secret text, mfa_enabled boolean NOT NULL DEFAULT false, last_totp_step bigint,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id)
);
-- Authentication tables intentionally use tightly scoped digest/email lookups before tenant context exists.
CREATE TABLE sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES identities(id),
 token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), ip inet, user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE password_resets (token_hash text PRIMARY KEY,user_id uuid NOT NULL REFERENCES identities(id),expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE permissions (code text PRIMARY KEY, description text NOT NULL);
CREATE TABLE security_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES companies(id), user_id uuid REFERENCES identities(id),
 action text NOT NULL, ip inet, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE branches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), name text NOT NULL, code text NOT NULL,
 address text, active boolean NOT NULL DEFAULT true, settings jsonb NOT NULL DEFAULT '{}', UNIQUE(company_id,id), UNIQUE(company_id,code)
);
CREATE TABLE warehouses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), branch_id uuid NOT NULL,
 name text NOT NULL, code text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(company_id,id), UNIQUE(company_id,code),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id)
);
CREATE TABLE registers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id), branch_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id), FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id)
);
CREATE TABLE roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,description text,
 approval_limit numeric(20,2) NOT NULL DEFAULT 0 CHECK(approval_limit>=0), UNIQUE(company_id,id),UNIQUE(company_id,name)
);
CREATE TABLE role_permissions (company_id uuid NOT NULL,role_id uuid NOT NULL,permission text NOT NULL REFERENCES permissions(code),PRIMARY KEY(company_id,role_id,permission),FOREIGN KEY(company_id,role_id) REFERENCES roles(company_id,id) ON DELETE CASCADE);
CREATE TABLE user_roles (company_id uuid NOT NULL,user_id uuid NOT NULL,role_id uuid NOT NULL,PRIMARY KEY(company_id,user_id,role_id),FOREIGN KEY(company_id,user_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,role_id) REFERENCES roles(company_id,id));
CREATE TABLE user_branches (company_id uuid NOT NULL,user_id uuid NOT NULL,branch_id uuid NOT NULL,PRIMARY KEY(company_id,user_id,branch_id),FOREIGN KEY(company_id,user_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id));
CREATE TABLE user_warehouses (company_id uuid NOT NULL,user_id uuid NOT NULL,warehouse_id uuid NOT NULL,PRIMARY KEY(company_id,user_id,warehouse_id),FOREIGN KEY(company_id,user_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id));
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),actor_id uuid NOT NULL,action text NOT NULL,
 entity text NOT NULL,record_id uuid,reason text, before_value jsonb,after_value jsonb,correlation_id text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,actor_id) REFERENCES identities(company_id,id)
);
CREATE INDEX audit_entity ON audit_logs(company_id,entity,record_id,created_at DESC);
CREATE TABLE idempotency_keys (
 company_id uuid NOT NULL,operation text NOT NULL,key text NOT NULL,request_hash text NOT NULL,response jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(company_id,operation,key),FOREIGN KEY(company_id) REFERENCES companies(id)
);
CREATE TABLE sequences (company_id uuid NOT NULL REFERENCES companies(id),kind text NOT NULL,value bigint NOT NULL DEFAULT 0,PRIMARY KEY(company_id,kind));
CREATE TABLE tax_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,code text NOT NULL,
 rate numeric(9,6) NOT NULL CHECK(rate>=0 AND rate<=100),kind text NOT NULL DEFAULT 'standard' CHECK(kind IN ('standard','zero','exempt','non_taxable')),
 valid_from date NOT NULL DEFAULT CURRENT_DATE,valid_to date,version integer NOT NULL DEFAULT 1,active boolean NOT NULL DEFAULT true,
 UNIQUE(company_id,id), UNIQUE(company_id,code,version),CHECK(valid_to IS NULL OR valid_to>=valid_from)
);
CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,parent_id uuid,UNIQUE(company_id,id),UNIQUE(company_id,name),FOREIGN KEY(company_id,parent_id) REFERENCES categories(company_id,id));
CREATE TABLE units (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,symbol text NOT NULL,fractional boolean NOT NULL DEFAULT false,UNIQUE(company_id,id),UNIQUE(company_id,symbol));
CREATE TABLE customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,code text NOT NULL,
 email text,phone text,tax_pin text,address text,credit_limit numeric(20,2) NOT NULL DEFAULT 0 CHECK(credit_limit>=0),credit_days integer NOT NULL DEFAULT 30 CHECK(credit_days>=0),
 discount_percent numeric(9,6) NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,code)
);
CREATE TABLE suppliers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,code text NOT NULL,
 email text,phone text,tax_pin text,address text,credit_days integer NOT NULL DEFAULT 30 CHECK(credit_days>=0),active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id),UNIQUE(company_id,code)
);
CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,description text,sku text NOT NULL,
 barcode text,category_id uuid,unit_id uuid NOT NULL,tax_rule_id uuid NOT NULL,supplier_id uuid,parent_id uuid,
 kind text NOT NULL DEFAULT 'stock' CHECK(kind IN ('stock','service','bundle')),brand text,manufacturer text,
 price numeric(20,2) NOT NULL CHECK(price>=0),purchase_cost numeric(24,6) NOT NULL DEFAULT 0 CHECK(purchase_cost>=0),min_price numeric(20,2) NOT NULL DEFAULT 0 CHECK(min_price>=0),
 tax_inclusive boolean NOT NULL DEFAULT true,reorder_level numeric(24,6) NOT NULL DEFAULT 0,max_stock numeric(24,6),
 batch_tracked boolean NOT NULL DEFAULT false,serial_tracked boolean NOT NULL DEFAULT false,expiry_tracked boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,sku),UNIQUE(company_id,barcode),
 FOREIGN KEY(company_id,category_id) REFERENCES categories(company_id,id),FOREIGN KEY(company_id,unit_id) REFERENCES units(company_id,id),
 FOREIGN KEY(company_id,tax_rule_id) REFERENCES tax_rules(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,parent_id) REFERENCES products(company_id,id),
 CHECK(NOT expiry_tracked OR batch_tracked),CHECK(NOT (serial_tracked AND kind<>'stock'))
);
CREATE INDEX product_search ON products(company_id,lower(name));
CREATE TABLE product_barcodes (company_id uuid NOT NULL,product_id uuid NOT NULL,barcode text NOT NULL,PRIMARY KEY(company_id,barcode),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id));
CREATE TABLE product_units (company_id uuid NOT NULL,product_id uuid NOT NULL,unit_id uuid NOT NULL,factor numeric(24,6) NOT NULL CHECK(factor>0),PRIMARY KEY(company_id,product_id,unit_id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,unit_id) REFERENCES units(company_id,id));
CREATE TABLE bundle_components (company_id uuid NOT NULL,bundle_id uuid NOT NULL,product_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),PRIMARY KEY(company_id,bundle_id,product_id),FOREIGN KEY(company_id,bundle_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),CHECK(bundle_id<>product_id));
CREATE TABLE price_lists (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,active boolean NOT NULL DEFAULT true,UNIQUE(company_id,id),UNIQUE(company_id,name));
CREATE TABLE prices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,product_id uuid NOT NULL,price_list_id uuid,customer_id uuid,supplier_id uuid,min_quantity numeric(24,6) NOT NULL DEFAULT 1,price numeric(20,2) NOT NULL CHECK(price>=0),UNIQUE(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,price_list_id) REFERENCES price_lists(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),CHECK(num_nonnulls(price_list_id,customer_id,supplier_id)=1));
CREATE UNIQUE INDEX unique_price_tier ON prices(company_id,product_id,price_list_id,customer_id,supplier_id,min_quantity) NULLS NOT DISTINCT;
CREATE TABLE accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),code text NOT NULL,name text NOT NULL,
 type text NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),system_key text,active boolean NOT NULL DEFAULT true,
 UNIQUE(company_id,id),UNIQUE(company_id,code),UNIQUE(company_id,system_key)
);
CREATE TABLE accounting_periods (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,start_date date NOT NULL,end_date date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),closed_by uuid,closed_at timestamptz,UNIQUE(company_id,id),
 FOREIGN KEY(company_id,closed_by) REFERENCES identities(company_id,id),CHECK(end_date>=start_date)
);
CREATE INDEX periods_dates ON accounting_periods(company_id,start_date,end_date);
CREATE TABLE journals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),branch_id uuid NOT NULL,number text NOT NULL,
 accounting_date date NOT NULL,source_type text NOT NULL,source_id uuid NOT NULL,description text NOT NULL,created_by uuid NOT NULL,
 reversal_of uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,source_type,source_id),UNIQUE(company_id,reversal_of),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,reversal_of) REFERENCES journals(company_id,id)
);
CREATE TABLE journal_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,journal_id uuid NOT NULL,account_id uuid NOT NULL,
 debit numeric(20,2) NOT NULL DEFAULT 0 CHECK(debit>=0),credit numeric(20,2) NOT NULL DEFAULT 0 CHECK(credit>=0),customer_id uuid,supplier_id uuid,memo text,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,journal_id) REFERENCES journals(company_id,id),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),
 FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0))
);
CREATE INDEX journal_account ON journal_lines(company_id,account_id,journal_id);
CREATE INDEX journal_dates ON journals(company_id,accounting_date,branch_id);
CREATE TABLE payment_methods (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id),name text NOT NULL,kind text NOT NULL CHECK(kind IN ('cash','mpesa','bank','card','cheque','other')),account_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,requires_reference boolean NOT NULL DEFAULT false,UNIQUE(company_id,id),UNIQUE(company_id,name),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id));
CREATE TABLE stock_balances (
 company_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,quantity numeric(24,6) NOT NULL DEFAULT 0 CHECK(quantity>=0),
 value numeric(24,6) NOT NULL DEFAULT 0 CHECK(value>=0),reserved numeric(24,6) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=quantity),version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(company_id,product_id,warehouse_id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),CHECK(quantity<>0 OR value=0)
);
CREATE TABLE stock_batches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,batch_number text NOT NULL,expiry_date date,quantity numeric(24,6) NOT NULL DEFAULT 0 CHECK(quantity>=0),UNIQUE(company_id,id),UNIQUE(company_id,product_id,warehouse_id,batch_number),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id));
CREATE TABLE serial_numbers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,serial text NOT NULL,status text NOT NULL CHECK(status IN ('available','sold','damaged')),UNIQUE(company_id,id),UNIQUE(company_id,product_id,serial),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id));
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,
 quantity numeric(24,6) NOT NULL CHECK(quantity<>0),value numeric(24,6) NOT NULL,cost numeric(24,6) NOT NULL CHECK(cost>=0),
 type text NOT NULL,source_type text NOT NULL,source_id uuid NOT NULL,line_key text NOT NULL,actor_id uuid NOT NULL,reason text NOT NULL,
 batch_id uuid,serials jsonb NOT NULL DEFAULT '[]',reversal_of uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),
 UNIQUE(company_id,source_type,source_id,line_key,product_id,warehouse_id),
 FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),
 FOREIGN KEY(company_id,actor_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,batch_id) REFERENCES stock_batches(company_id,id),FOREIGN KEY(company_id,reversal_of) REFERENCES stock_movements(company_id,id),
 CHECK((quantity>0 AND value>=0) OR (quantity<0 AND value<=0))
);
CREATE INDEX stock_history ON stock_movements(company_id,product_id,warehouse_id,created_at);
CREATE TABLE shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,register_id uuid NOT NULL,branch_id uuid NOT NULL,cashier_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','approved','rejected')),opening_float numeric(20,2) NOT NULL CHECK(opening_float>=0),
 opened_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,counts jsonb,expected jsonb,denominations jsonb,variance numeric(20,2),reviewed_by uuid,review_reason text,
 UNIQUE(company_id,id),FOREIGN KEY(company_id,register_id) REFERENCES registers(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),
 FOREIGN KEY(company_id,cashier_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,reviewed_by) REFERENCES identities(company_id,id)
);
CREATE UNIQUE INDEX one_open_register ON shifts(company_id,register_id) WHERE status IN ('open','rejected');
CREATE UNIQUE INDEX one_open_cashier ON shifts(company_id,cashier_id) WHERE status IN ('open','rejected');
CREATE TABLE sales (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,warehouse_id uuid NOT NULL,register_id uuid NOT NULL,shift_id uuid NOT NULL,
 number text NOT NULL,customer_id uuid,created_by uuid NOT NULL,accounting_date date NOT NULL,due_date date NOT NULL,
 subtotal numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,total numeric(20,2) NOT NULL CHECK(total>=0),paid_at_sale numeric(20,2) NOT NULL CHECK(paid_at_sale>=0 AND paid_at_sale<=total),
 cost numeric(20,2) NOT NULL,discount numeric(20,2) NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'posted' CHECK(status='posted'),notes text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),
 FOREIGN KEY(company_id,register_id) REFERENCES registers(company_id,id),FOREIGN KEY(company_id,shift_id) REFERENCES shifts(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),
 CHECK(subtotal+tax=total),CHECK(customer_id IS NOT NULL OR paid_at_sale=total)
);
CREATE INDEX sales_dates ON sales(company_id,accounting_date,branch_id);
CREATE TABLE sale_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,sale_id uuid NOT NULL,product_id uuid NOT NULL,description text NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),
 base_quantity numeric(24,6) NOT NULL,unit_id uuid NOT NULL,unit_price numeric(20,2) NOT NULL,discount numeric(20,2) NOT NULL,tax_rate numeric(9,6) NOT NULL,tax_kind text NOT NULL,
 net numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,total numeric(20,2) NOT NULL,cost numeric(24,6) NOT NULL,batch_id uuid,serials jsonb NOT NULL DEFAULT '[]',components jsonb NOT NULL DEFAULT '[]',
 UNIQUE(company_id,id),FOREIGN KEY(company_id,sale_id) REFERENCES sales(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,unit_id) REFERENCES units(company_id,id),FOREIGN KEY(company_id,batch_id) REFERENCES stock_batches(company_id,id),CHECK(net+tax=total)
);
CREATE TABLE payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,method_id uuid NOT NULL,shift_id uuid,
 amount numeric(20,2) NOT NULL CHECK(amount>0),direction text NOT NULL CHECK(direction IN ('in','out')),source_type text NOT NULL,source_id uuid NOT NULL,
 reference text,created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,method_id) REFERENCES payment_methods(company_id,id),FOREIGN KEY(company_id,shift_id) REFERENCES shifts(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE UNIQUE INDEX payment_external_reference ON payments(company_id,method_id,reference) WHERE reference IS NOT NULL;
CREATE INDEX payment_source ON payments(company_id,source_type,source_id);
CREATE TABLE cash_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,shift_id uuid NOT NULL,direction text NOT NULL CHECK(direction IN ('in','out')),amount numeric(20,2) NOT NULL CHECK(amount>0),
 reason text NOT NULL,account_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),
 FOREIGN KEY(company_id,shift_id) REFERENCES shifts(company_id,id),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE sale_returns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,sale_id uuid NOT NULL,number text NOT NULL,branch_id uuid NOT NULL,
 total numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,cost numeric(20,2) NOT NULL,refund numeric(20,2) NOT NULL,credit_applied numeric(20,2) NOT NULL,
 reason text NOT NULL,created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),
 FOREIGN KEY(company_id,sale_id) REFERENCES sales(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),CHECK(refund+credit_applied=total)
);
CREATE TABLE sale_return_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,return_id uuid NOT NULL,sale_line_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),net numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,cost numeric(24,6) NOT NULL,restock boolean NOT NULL,UNIQUE(company_id,id),FOREIGN KEY(company_id,return_id) REFERENCES sale_returns(company_id,id),FOREIGN KEY(company_id,sale_line_id) REFERENCES sale_lines(company_id,id));
CREATE TABLE customer_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,number text NOT NULL,
 amount numeric(20,2) NOT NULL CHECK(amount>0),unapplied numeric(20,2) NOT NULL CHECK(unapplied>=0),created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE customer_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,receipt_id uuid NOT NULL,sale_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),UNIQUE(company_id,id),UNIQUE(company_id,receipt_id,sale_id),FOREIGN KEY(company_id,receipt_id) REFERENCES customer_receipts(company_id,id),FOREIGN KEY(company_id,sale_id) REFERENCES sales(company_id,id));
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,supplier_id uuid NOT NULL,warehouse_id uuid NOT NULL,number text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','closed','cancelled')),expected_date date,notes text,created_by uuid NOT NULL,approved_by uuid,approval_reason text,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,approved_by) REFERENCES identities(company_id,id)
);
CREATE TABLE purchase_order_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,order_id uuid NOT NULL,product_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),unit_cost numeric(24,6) NOT NULL CHECK(unit_cost>=0),UNIQUE(company_id,id),FOREIGN KEY(company_id,order_id) REFERENCES purchase_orders(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id));
CREATE TABLE goods_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,warehouse_id uuid NOT NULL,supplier_id uuid NOT NULL,order_id uuid NOT NULL,number text NOT NULL,
 value numeric(20,2) NOT NULL,reason text,created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,order_id) REFERENCES purchase_orders(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE goods_receipt_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,receipt_id uuid NOT NULL,order_line_id uuid NOT NULL,product_id uuid NOT NULL,
 quantity numeric(24,6) NOT NULL CHECK(quantity>0),rejected_quantity numeric(24,6) NOT NULL DEFAULT 0 CHECK(rejected_quantity>=0),unit_cost numeric(24,6) NOT NULL CHECK(unit_cost>=0),value numeric(24,6) NOT NULL,batch_id uuid,serials jsonb NOT NULL DEFAULT '[]',
 UNIQUE(company_id,id),FOREIGN KEY(company_id,receipt_id) REFERENCES goods_receipts(company_id,id),FOREIGN KEY(company_id,order_line_id) REFERENCES purchase_order_lines(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,batch_id) REFERENCES stock_batches(company_id,id)
);
CREATE TABLE supplier_invoices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,supplier_id uuid NOT NULL,receipt_id uuid NOT NULL,number text NOT NULL,supplier_reference text NOT NULL,
 subtotal numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,total numeric(20,2) NOT NULL,accounting_date date NOT NULL,due_date date NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,id),UNIQUE(company_id,number),UNIQUE(company_id,supplier_id,supplier_reference),UNIQUE(company_id,receipt_id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,receipt_id) REFERENCES goods_receipts(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),CHECK(subtotal+tax=total)
);
CREATE TABLE supplier_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,invoice_id uuid NOT NULL,receipt_line_id uuid NOT NULL,net numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,tax_rate numeric(9,6) NOT NULL,UNIQUE(company_id,id),FOREIGN KEY(company_id,invoice_id) REFERENCES supplier_invoices(company_id,id),FOREIGN KEY(company_id,receipt_line_id) REFERENCES goods_receipt_lines(company_id,id));
CREATE TABLE supplier_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,supplier_id uuid NOT NULL,number text NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),unapplied numeric(20,2) NOT NULL CHECK(unapplied>=0),
 created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE supplier_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,payment_id uuid NOT NULL,invoice_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),UNIQUE(company_id,id),UNIQUE(company_id,payment_id,invoice_id),FOREIGN KEY(company_id,payment_id) REFERENCES supplier_payments(company_id,id),FOREIGN KEY(company_id,invoice_id) REFERENCES supplier_invoices(company_id,id));
CREATE TABLE supplier_returns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,invoice_id uuid NOT NULL,number text NOT NULL,total numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,reason text NOT NULL,created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,invoice_id) REFERENCES supplier_invoices(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE supplier_return_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,return_id uuid NOT NULL,receipt_line_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),net numeric(20,2) NOT NULL,tax numeric(20,2) NOT NULL,UNIQUE(company_id,id),FOREIGN KEY(company_id,return_id) REFERENCES supplier_returns(company_id,id),FOREIGN KEY(company_id,receipt_line_id) REFERENCES goods_receipt_lines(company_id,id));
CREATE TABLE stock_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,warehouse_id uuid NOT NULL,destination_id uuid,type text NOT NULL CHECK(type IN ('opening','adjustment','transfer','count')),
 number text NOT NULL,reason text NOT NULL,status text NOT NULL DEFAULT 'posted' CHECK(status IN ('draft','posted')),created_by uuid NOT NULL,accounting_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),FOREIGN KEY(company_id,destination_id) REFERENCES warehouses(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
CREATE TABLE stock_document_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,document_id uuid NOT NULL,product_id uuid NOT NULL,quantity numeric(24,6) NOT NULL,unit_cost numeric(24,6) NOT NULL,system_quantity numeric(24,6),counted_quantity numeric(24,6),batch_id uuid,UNIQUE(company_id,id),FOREIGN KEY(company_id,document_id) REFERENCES stock_documents(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id));
CREATE TABLE business_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,warehouse_id uuid,number text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('quotation','sales_order','delivery_note','requisition')),status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','converted','cancelled')),
 customer_id uuid,supplier_id uuid,source_id uuid,sale_id uuid,lines jsonb NOT NULL,subtotal numeric(20,2) NOT NULL DEFAULT 0,tax numeric(20,2) NOT NULL DEFAULT 0,total numeric(20,2) NOT NULL DEFAULT 0,
 notes text,created_by uuid NOT NULL,approved_by uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id),FOREIGN KEY(company_id,customer_id) REFERENCES customers(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,source_id) REFERENCES business_documents(company_id,id),FOREIGN KEY(company_id,sale_id) REFERENCES sales(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,approved_by) REFERENCES identities(company_id,id)
);
CREATE TABLE stock_reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,document_id uuid NOT NULL,product_id uuid NOT NULL,warehouse_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','released','consumed')),UNIQUE(company_id,id),FOREIGN KEY(company_id,document_id) REFERENCES business_documents(company_id,id),FOREIGN KEY(company_id,product_id) REFERENCES products(company_id,id),FOREIGN KEY(company_id,warehouse_id) REFERENCES warehouses(company_id,id));
CREATE TABLE suspended_sales (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,user_id uuid NOT NULL,branch_id uuid NOT NULL,label text NOT NULL,cart jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),FOREIGN KEY(company_id,user_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id));
CREATE TABLE expense_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,name text NOT NULL,account_id uuid NOT NULL,UNIQUE(company_id,id),UNIQUE(company_id,name),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id));
CREATE TABLE expenses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,category_id uuid NOT NULL,supplier_id uuid,number text NOT NULL,description text NOT NULL,
 net numeric(20,2) NOT NULL CHECK(net>=0),tax numeric(20,2) NOT NULL CHECK(tax>=0),total numeric(20,2) NOT NULL CHECK(total>0),
 status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected','posted')),created_by uuid NOT NULL,approved_by uuid,approval_reason text,accounting_date date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,number),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,category_id) REFERENCES expense_categories(company_id,id),FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,approved_by) REFERENCES identities(company_id,id),CHECK(net+tax=total)
);
CREATE TABLE budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,account_id uuid NOT NULL,period_id uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>=0),UNIQUE(company_id,id),UNIQUE(company_id,branch_id,account_id,period_id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,period_id) REFERENCES accounting_periods(company_id,id));
CREATE TABLE fixed_assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,name text NOT NULL,cost numeric(20,2) NOT NULL CHECK(cost>0),residual numeric(20,2) NOT NULL DEFAULT 0 CHECK(residual>=0),useful_months integer NOT NULL CHECK(useful_months>0),acquired_date date NOT NULL,asset_account_id uuid NOT NULL,accumulated_account_id uuid NOT NULL,expense_account_id uuid NOT NULL,created_by uuid NOT NULL,UNIQUE(company_id,id),FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,asset_account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,accumulated_account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,expense_account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id),CHECK(residual<=cost));
CREATE TABLE depreciation_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,asset_id uuid NOT NULL,month date NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),UNIQUE(company_id,id),UNIQUE(company_id,asset_id,month),FOREIGN KEY(company_id,asset_id) REFERENCES fixed_assets(company_id,id));
CREATE TABLE bank_reconciliations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,account_id uuid NOT NULL,statement_date date NOT NULL,statement_balance numeric(20,2) NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','reconciled')),created_by uuid NOT NULL,UNIQUE(company_id,id),FOREIGN KEY(company_id,account_id) REFERENCES accounts(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id));
CREATE TABLE bank_reconciliation_lines (company_id uuid NOT NULL,reconciliation_id uuid NOT NULL,journal_line_id uuid NOT NULL,PRIMARY KEY(company_id,reconciliation_id,journal_line_id),UNIQUE(company_id,journal_line_id),FOREIGN KEY(company_id,reconciliation_id) REFERENCES bank_reconciliations(company_id,id),FOREIGN KEY(company_id,journal_line_id) REFERENCES journal_lines(company_id,id));
CREATE TABLE attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,entity text NOT NULL,record_id uuid NOT NULL,filename text NOT NULL,storage_key text NOT NULL UNIQUE,mime_type text NOT NULL,size integer NOT NULL CHECK(size>0 AND size<=5242880),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id));
CREATE TABLE payment_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,branch_id uuid NOT NULL,created_by uuid NOT NULL,amount numeric(20,2) NOT NULL CHECK(amount>0),phone text NOT NULL,
 provider text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','successful','failed','cancelled','timed_out')),checkout_id text UNIQUE,receipt_number text UNIQUE,
 consumed_by uuid,callback_token_hash text NOT NULL,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),
 FOREIGN KEY(company_id,branch_id) REFERENCES branches(company_id,id),FOREIGN KEY(company_id,created_by) REFERENCES identities(company_id,id)
);
-- Callback inbox is global: opaque checkout lookup before tenant context, redacted payloads only.
CREATE TABLE provider_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),provider text NOT NULL,event_key text NOT NULL UNIQUE,checkout_id text NOT NULL,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'received',attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE fiscal_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,source_type text NOT NULL,source_id uuid NOT NULL,status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','pending','processing','successful','failed')),fiscal_id text,response jsonb,error text,attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,source_type,source_id),CHECK(status<>'successful' OR fiscal_id IS NOT NULL));
CREATE TABLE sync_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL,client_id uuid NOT NULL,device_id text NOT NULL,user_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('posted','conflict')),sale_id uuid,error jsonb,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(company_id,id),UNIQUE(company_id,client_id),FOREIGN KEY(company_id,user_id) REFERENCES identities(company_id,id),FOREIGN KEY(company_id,sale_id) REFERENCES sales(company_id,id));
CREATE TABLE mail_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient text NOT NULL,subject text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now());

-- No posted financial/stock history may be overwritten. A journal cannot gain lines after its creating transaction.
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable posted record; create an authorized reversal' USING ERRCODE='23514'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['journals','journal_lines','stock_movements','audit_logs','payments','sales','sale_lines','sale_returns','sale_return_lines','goods_receipts','goods_receipt_lines','supplier_invoices','supplier_invoice_lines','customer_receipts','customer_allocations','supplier_payments','supplier_allocations','supplier_returns','supplier_return_lines'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()','immutable_'||t,t);
END LOOP; END $$;
CREATE FUNCTION protect_journal_lines() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM journals WHERE id=NEW.journal_id AND company_id=NEW.company_id AND xmin::text=pg_current_xact_id()::text) THEN
 RAISE EXCEPTION 'cannot append to a posted journal' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER journal_no_append BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION protect_journal_lines();
CREATE FUNCTION journal_must_balance() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE dr numeric;cr numeric;n bigint; BEGIN
 SELECT coalesce(sum(debit),0),coalesce(sum(credit),0),count(*) INTO dr,cr,n FROM journal_lines WHERE company_id=NEW.company_id AND journal_id=NEW.id;
 IF n<2 OR dr<>cr THEN RAISE EXCEPTION 'unbalanced journal %: debit %, credit %, lines %',NEW.id,dr,cr,n USING ERRCODE='23514'; END IF; RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_must_balance();
-- Closing a period serializes against posting, and the DB independently rejects closed/missing periods.
CREATE FUNCTION journal_open_period() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM 1 FROM accounting_periods WHERE company_id=NEW.company_id AND NEW.accounting_date BETWEEN start_date AND end_date AND status='open' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'no open accounting period for %',NEW.accounting_date USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER period_guard BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION journal_open_period();

-- FORCE ensures even table owners obey tenant isolation. Pre-auth tables are deliberately excluded.
DO $$ DECLARE t text; BEGIN FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='company_id' AND table_name NOT IN ('identities','security_events') LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid) WITH CHECK (company_id=nullif(current_setting(''app.company_id'',true),'''')::uuid)',t);
END LOOP; END $$;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON companies USING(id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(id=nullif(current_setting('app.company_id',true),'')::uuid);
