-- Cashiers could not complete credit sales: POST /sales requires sales.credit
-- whenever a balance is left on account, but the seeded Cashier role never held
-- it, so the POS silently disabled checkout for remaining balances. Grant the
-- permission to every seeded Cashier role. New companies receive the same grant
-- via defaultRoles. Exceeding a customer's credit limit still requires
-- sales.credit_override, which stays management-only.
INSERT INTO permissions(code, description) VALUES
  ('sales.credit', 'sell on credit / leave a balance on a customer account'),
  ('sales.credit_override', 'override customer credit limits with a recorded reason')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission)
SELECT company_id, id, 'sales.credit' FROM roles WHERE name = 'Cashier'
ON CONFLICT DO NOTHING;
