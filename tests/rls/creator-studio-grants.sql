-- Exact per-table privileges tests/rls/creator-studio-isolation.sql's client
-- assertions require -- deliberately narrower than "all tables in schema
-- public". Mirrors tests/rls/isolation-grants.sql's shape:
--   - creator_profiles:   SELECT + INSERT (cross-tenant visibility/insert) and
--                         UPDATE (own-tenant update, reassignment rejection,
--                         guessed-id rejection -- WITH CHECK coverage)
--   - creator_campaigns:  same SELECT/INSERT/UPDATE shape
--   - creator_generations, creator_templates, creator_posts: SELECT only --
--     no client policy exists for INSERT/UPDATE on these (server-service-only
--     writes), so only cross-tenant visibility is exercised
-- Run by scripts/ci/run-rls-check.sh via `psql -v role_name=...`; :"role_name"
-- is a psql identifier variable, never a raw string concatenated into SQL.

grant usage on schema public to :"role_name";
grant select, insert, update on creator_profiles to :"role_name";
grant select, insert, update on creator_campaigns to :"role_name";
grant select on creator_generations to :"role_name";
grant select on creator_templates to :"role_name";
grant select on creator_posts to :"role_name";
