-- Verifies the ephemeral role for the Creator Studio suite has EXACTLY the
-- table privileges tests/rls/creator-studio-grants.sql grants -- no more and
-- no less. Run by scripts/ci/run-rls-check.sh immediately after granting
-- privileges and before loading fixtures, via `psql -v role_name=...`.
select set_config('rls_check.role_name', :'role_name', false);

do $$
declare
  target_role text := current_setting('rls_check.role_name');
  extra_count int;
  missing_count int;
begin
  select count(*) into extra_count
  from information_schema.role_table_grants
  where grantee = target_role
    and table_schema = 'public'
    and (table_name, privilege_type) not in (
      ('creator_profiles', 'SELECT'), ('creator_profiles', 'INSERT'), ('creator_profiles', 'UPDATE'),
      ('creator_campaigns', 'SELECT'), ('creator_campaigns', 'INSERT'), ('creator_campaigns', 'UPDATE'),
      ('creator_generations', 'SELECT'),
      ('creator_templates', 'SELECT'),
      ('creator_posts', 'SELECT')
    );
  if extra_count <> 0 then
    raise exception 'CS PRIVILEGE ALLOWLIST FAIL: % privilege(s) granted beyond the allowlist', extra_count;
  end if;

  select count(*) into missing_count
  from (
    values
      ('creator_profiles', 'SELECT'), ('creator_profiles', 'INSERT'), ('creator_profiles', 'UPDATE'),
      ('creator_campaigns', 'SELECT'), ('creator_campaigns', 'INSERT'), ('creator_campaigns', 'UPDATE'),
      ('creator_generations', 'SELECT'),
      ('creator_templates', 'SELECT'),
      ('creator_posts', 'SELECT')
  ) as expected(table_name, privilege_type)
  where not exists (
    select 1
    from information_schema.role_table_grants as g
    where g.grantee = target_role
      and g.table_schema = 'public'
      and g.table_name = expected.table_name
      and g.privilege_type = expected.privilege_type
  );
  if missing_count <> 0 then
    raise exception 'CS PRIVILEGE ALLOWLIST FAIL: % expected privilege(s) missing', missing_count;
  end if;
end $$;
