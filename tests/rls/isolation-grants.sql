-- Exact per-table privileges tests/rls/isolation.sql's client assertions
-- require -- deliberately narrower than "all tables in schema public", so the
-- ephemeral role can do no more than those assertions actually exercise:
--   - contacts:       SELECT (own-tenant/cross-tenant visibility) and INSERT
--                      (proves RLS's WITH CHECK, not a missing grant, rejects
--                      a cross-tenant insert)
--   - organizations:  SELECT only (no write ever attempted against it here)
--   - subscriptions:  INSERT only (proves RLS, not a missing grant, makes it
--                      read-only from this role; no SELECT is ever run)
-- Run by scripts/ci/run-rls-check.sh via `psql -v role_name=...`; :"role_name"
-- is a psql identifier variable, never a raw string concatenated into SQL.

grant usage on schema public to :"role_name";
grant select, insert on contacts to :"role_name";
grant select on organizations to :"role_name";
grant insert on subscriptions to :"role_name";
