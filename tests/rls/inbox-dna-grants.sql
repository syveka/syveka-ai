-- Exact per-table privileges tests/rls/inbox-dna-isolation.sql's client
-- assertions require -- deliberately narrower than "all tables in schema
-- public":
--   - business_dna, business_dna_services: SELECT, INSERT, UPDATE, DELETE --
--       both tables have real client policies (business_dna_select/_insert/
--       _update/_delete and business_dna_services_ equivalents), and the
--       assertions exercise all four to prove RLS's USING/WITH CHECK
--       clauses, not a missing grant, is what scopes and rejects them.
--   - inbox_threads: SELECT, INSERT -- server-only table (RLS enabled, no
--       client policies at all); SELECT proves it returns zero rows despite
--       fixtures existing, INSERT proves the attempt is rejected by RLS
--       (default-deny with no policy), not merely absent from view.
--   - inbox_messages, inbox_mailboxes: SELECT only -- same server-only
--       zero-rows-visible proof; no write ever attempted against either.
-- Run by scripts/ci/run-rls-check.sh via `psql -v role_name=...`; :"role_name"
-- is a psql identifier variable, never a raw string concatenated into SQL.

grant usage on schema public to :"role_name";
grant select, insert, update, delete on business_dna to :"role_name";
grant select, insert, update, delete on business_dna_services to :"role_name";
grant select, insert on inbox_threads to :"role_name";
grant select on inbox_messages to :"role_name";
grant select on inbox_mailboxes to :"role_name";
