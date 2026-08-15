-- Verifies the ephemeral role for the inbox/business-dna suite has EXACTLY
-- the table privileges tests/rls/inbox-dna-grants.sql grants -- no more and
-- no less. Run by scripts/ci/run-rls-check.sh immediately after granting
-- privileges and before loading fixtures, via `psql -v role_name=...`.
--
-- psql's :"var"/:'var' substitution does not apply inside a $$...$$
-- dollar-quoted block (the whole point of dollar-quoting is that psql does
-- not preprocess its contents), so :'role_name' is resolved here, at the top
-- level, into a session setting the DO block below reads back with
-- current_setting() -- not referenced directly inside the block itself.
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
      ('business_dna', 'SELECT'), ('business_dna', 'INSERT'),
      ('business_dna', 'UPDATE'), ('business_dna', 'DELETE'),
      ('business_dna_services', 'SELECT'), ('business_dna_services', 'INSERT'),
      ('business_dna_services', 'UPDATE'), ('business_dna_services', 'DELETE'),
      ('inbox_threads', 'SELECT'), ('inbox_threads', 'INSERT'),
      ('inbox_messages', 'SELECT'),
      ('inbox_mailboxes', 'SELECT')
    );
  if extra_count <> 0 then
    raise exception 'INBOX-DNA PRIVILEGE ALLOWLIST FAIL: % privilege(s) granted beyond the allowlist', extra_count;
  end if;

  select count(*) into missing_count
  from (
    values
      ('business_dna', 'SELECT'), ('business_dna', 'INSERT'),
      ('business_dna', 'UPDATE'), ('business_dna', 'DELETE'),
      ('business_dna_services', 'SELECT'), ('business_dna_services', 'INSERT'),
      ('business_dna_services', 'UPDATE'), ('business_dna_services', 'DELETE'),
      ('inbox_threads', 'SELECT'), ('inbox_threads', 'INSERT'),
      ('inbox_messages', 'SELECT'),
      ('inbox_mailboxes', 'SELECT')
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
    raise exception 'INBOX-DNA PRIVILEGE ALLOWLIST FAIL: % expected privilege(s) missing', missing_count;
  end if;
end $$;
