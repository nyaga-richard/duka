-- Route (van) sales: named routes with an assigned salesperson and till,
-- customers bound to exactly one route, and route-tagged shifts so loading
-- sheets, delivery sheets and route ledgers group cleanly per shift.
CREATE TABLE routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  salesperson_id uuid,
  register_id uuid,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,id),UNIQUE(company_id,code),
  FOREIGN KEY(company_id,salesperson_id) REFERENCES identities(company_id,id),
  FOREIGN KEY(company_id,register_id) REFERENCES registers(company_id,id)
);
ALTER TABLE routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routes USING(company_id=nullif(current_setting('app.company_id',true),'')::uuid) WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid);

ALTER TABLE customers ADD COLUMN route_id uuid;
ALTER TABLE customers ADD CONSTRAINT customers_route_fk FOREIGN KEY(company_id,route_id) REFERENCES routes(company_id,id);
CREATE INDEX customers_route ON customers(company_id,route_id) WHERE route_id IS NOT NULL;

ALTER TABLE shifts ADD COLUMN route_id uuid;
ALTER TABLE shifts ADD CONSTRAINT shifts_route_fk FOREIGN KEY(company_id,route_id) REFERENCES routes(company_id,id);
CREATE INDEX shifts_route ON shifts(company_id,route_id) WHERE route_id IS NOT NULL;

INSERT INTO permissions(code, description) VALUES
  ('routes.read', 'view routes, route ledgers and route shift sheets'),
  ('routes.manage', 'create and edit routes and their assignments'),
  ('routes.shift', 'open and close route shifts and post route invoices')
ON CONFLICT DO NOTHING;

-- Grant the new and route-required permissions to seeded roles. In production
-- this runs as duka_migrator (BYPASSRLS); sandboxes replay it privileged from
-- revive-sandbox.sh because roles are FORCE RLS for the runtime role.
INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES
  ('routes.read'), ('routes.manage'), ('routes.shift')
) AS p(permission)
WHERE r.name IN ('Business owner','General manager','Branch manager')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, p.permission FROM roles r
CROSS JOIN (VALUES
  ('routes.read'), ('routes.shift'), ('sales.create'), ('sales.credit'),
  ('shifts.open'), ('payments.receive')
) AS p(permission)
WHERE r.name = 'Salesperson'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions(company_id, role_id, permission)
SELECT r.company_id, r.id, 'routes.read' FROM roles r
WHERE r.name = 'Accountant'
ON CONFLICT DO NOTHING;
