-- Match the established request context key; never rewrite applied migration016.
ALTER POLICY tenant_isolation ON cancelled_commands
 WITH CHECK(company_id=nullif(current_setting('app.company_id',true),'')::uuid AND actor_id=nullif(current_setting('app.actor_id',true),'')::uuid);
