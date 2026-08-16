-- Exact per-table privileges tests/rls/isolation.sql's client assertions
-- require -- deliberately narrower than "all tables in schema public", so the
-- ephemeral role can do no more than those assertions actually exercise:
--   - contacts:       SELECT (own-tenant/cross-tenant visibility) and INSERT
--                      (proves RLS's WITH CHECK, not a missing grant, rejects
--                      a cross-tenant insert)
--   - organizations:  SELECT only (no write ever attempted against it here)
--   - subscriptions:  INSERT only (proves RLS, not a missing grant, makes it
--                      read-only from this role; no SELECT is ever run)
--   - every table hardened by 20260817000000_tenant_update_rls_with_check_
--     hardening: SELECT + UPDATE, so a rejected cross-tenant/reassignment
--     UPDATE proves RLS's WITH CHECK, not a missing grant, is what blocks it
-- Run by scripts/ci/run-rls-check.sh via `psql -v role_name=...`; :"role_name"
-- is a psql identifier variable, never a raw string concatenated into SQL.

grant usage on schema public to :"role_name";
grant select, insert on contacts to :"role_name";
grant select on organizations to :"role_name";
grant insert on subscriptions to :"role_name";
grant select, update on teams to :"role_name";
grant select, update on companies to :"role_name";
grant select, update on pipelines to :"role_name";
grant select, update on tags to :"role_name";
grant select, update on deals to :"role_name";
grant select, update on activities to :"role_name";
grant select, update on calendar_events to :"role_name";
grant select, update on conversations to :"role_name";
grant select, update on collections to :"role_name";
grant select, update on documents to :"role_name";
grant select, update on workflows to :"role_name";
grant select, update on voice_assistants to :"role_name";
grant select, update on webhook_endpoints to :"role_name";
grant select, update on prompts to :"role_name";
grant select, update on notifications to :"role_name";
