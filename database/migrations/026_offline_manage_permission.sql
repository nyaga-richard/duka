-- Dedicated permission for offline capture device administration. Post-upgrade
-- `offline.manage` OR legacy `sales.price_override` authorizes; existing role
-- rows keep working unchanged, new roles can grant the finer permission.
INSERT INTO permissions(code, description) VALUES ('offline.manage', 'offline / manage offline capture devices') ON CONFLICT DO NOTHING;
