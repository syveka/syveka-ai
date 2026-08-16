-- Inbox & Business DNA RLS catalog and tenant-behavior assertions.
--
-- Run directly as an already-authenticated, ephemeral LOGIN role that is a
-- member of `authenticated` -- see scripts/ci/run-rls-check.sh, which creates
-- that role, grants it privileges, and loads
-- tests/rls/inbox-dna-fixtures.sql through a separate administrative
-- connection before this file ever runs. This file never creates a role,
-- never grants anything to itself, and never uses SET ROLE: the connection
-- this runs over IS the client role for real. Every attempted write below
-- happens inside a transaction that always rolls back; the fixtures
-- themselves are cleaned up separately, by the administrative connection,
-- after this file returns.
--
-- business_dna and business_dna_services both have real client policies
-- (select/insert/update/delete, all scoped to organization_id =
-- auth_org_id()) -- covered here with the same depth as
-- calendar-booking-isolation.sql covers booking_types/availability_rules.
-- The business_dna_services assertions run before the business_dna delete
-- test below, deliberately: business_dna_services.business_dna_id cascades
-- from business_dna, so testing it after that row is deleted (even inside
-- this same still-open, later-rolled-back transaction) would find zero rows
-- for the wrong reason. inbox_threads/inbox_messages/inbox_mailboxes are
-- server-only (RLS enabled, zero CREATE POLICY statements -- see
-- 20260811010000_inbox_mvp_foundation and 20260812000000_inbox_mailboxes):
-- default-deny by omission, previously untested at the SQL level. This file
-- proves that default-deny actually holds, not merely that no policy is
-- declared.

do $$
declare
  enabled_count integer;
  dna_policy_count integer;
begin
  select count(*) into enabled_count
  from pg_class
  where oid in (
    'public.business_dna'::regclass,
    'public.business_dna_services'::regclass,
    'public.inbox_threads'::regclass,
    'public.inbox_messages'::regclass,
    'public.inbox_mailboxes'::regclass
  )
    and relrowsecurity;

  if enabled_count <> 5 then
    raise exception 'INBOX-DNA RLS FAIL: expected RLS on 5 tables, found %', enabled_count;
  end if;

  select count(*) into dna_policy_count
  from (
    values
      ('business_dna', 'business_dna_select', 'SELECT'),
      ('business_dna', 'business_dna_insert', 'INSERT'),
      ('business_dna', 'business_dna_update', 'UPDATE'),
      ('business_dna', 'business_dna_delete', 'DELETE'),
      ('business_dna_services', 'business_dna_services_select', 'SELECT'),
      ('business_dna_services', 'business_dna_services_insert', 'INSERT'),
      ('business_dna_services', 'business_dna_services_update', 'UPDATE'),
      ('business_dna_services', 'business_dna_services_delete', 'DELETE')
  ) as expected(tablename, policyname, cmd)
  join pg_policies as policy
    on policy.schemaname = 'public'
   and policy.tablename = expected.tablename
   and policy.policyname = expected.policyname
   and policy.cmd = expected.cmd
   and policy.roles @> array['authenticated']::name[];

  if dna_policy_count <> 8 then
    raise exception 'INBOX-DNA RLS FAIL: expected 8 authenticated business_dna/business_dna_services policies, found %', dna_policy_count;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array['inbox_threads', 'inbox_messages', 'inbox_mailboxes'])
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'INBOX-DNA RLS FAIL: authenticated/public policy exists on a server-only inbox table';
  end if;
end $$;

begin;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'e0000000-0000-4000-8000-000000000001',
  'role', 'OWNER',
  'org_id', '51111111-0000-4000-8000-000000000000'
)::text, true);

do $$
declare
  n integer;
  affected_rows integer;
begin
  -- business_dna: own-tenant row visible, cross-tenant row hidden.
  select count(*) into n from business_dna;
  if n <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: expected 1 visible business_dna row, got %', n;
  end if;

  -- inbox_threads/inbox_messages/inbox_mailboxes: zero rows visible despite
  -- fixtures existing for this org -- default-deny by omission, proven live.
  select count(*) into n from inbox_threads;
  if n <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: inbox_threads exposed % row(s) with no authenticated policy', n;
  end if;

  select count(*) into n from inbox_messages;
  if n <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: inbox_messages exposed % row(s) with no authenticated policy', n;
  end if;

  select count(*) into n from inbox_mailboxes;
  if n <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: inbox_mailboxes exposed % row(s) with no authenticated policy', n;
  end if;

  -- business_dna: cross-tenant insert rejected by WITH CHECK.
  begin
    insert into business_dna (organization_id, updated_at)
      values ('52222222-0000-4000-8000-000000000000', now());
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna insert allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- business_dna: cross-tenant update rejected (zero rows affected).
  update business_dna
  set display_name = 'Hacked'
  where organization_id = '52222222-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna update affected % row(s)', affected_rows;
  end if;

  -- business_dna: own-tenant update allowed.
  update business_dna
  set display_name = 'Updated by owner'
  where organization_id = '51111111-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: own-tenant business_dna update affected % row(s), expected 1', affected_rows;
  end if;

  -- business_dna: an owner of org A, authorized to update their own row,
  -- cannot reassign it to org B via UPDATE ... SET organization_id.
  -- business_dna_update's WITH CHECK (20260816000000_business_dna_rls_update
  -- _with_check) revalidates the RESULTING row, not just the row being
  -- matched -- this is the RLS hardening this migration exists to prove.
  begin
    update business_dna
    set organization_id = '52222222-0000-4000-8000-000000000000'
    where organization_id = '51111111-0000-4000-8000-000000000000';
    raise exception 'INBOX-DNA RLS FAIL: business_dna organization_id reassignment (A -> B) was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- business_dna: a guessed org B business_dna id cannot be updated directly
  -- by primary key, independent of whether the attacker also happens to
  -- filter by organization_id.
  update business_dna
  set display_name = 'Hijacked by guessed id'
  where id = '53000000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: guessed org B business_dna id was updatable, affected % row(s)', affected_rows;
  end if;

  -- business_dna_services: own-tenant row visible, cross-tenant row hidden.
  select count(*) into n from business_dna_services;
  if n <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: expected 1 visible business_dna_services row, got %', n;
  end if;

  -- business_dna_services: cross-tenant insert rejected by WITH CHECK.
  begin
    insert into business_dna_services (organization_id, business_dna_id, name, updated_at)
      values (
        '52222222-0000-4000-8000-000000000000',
        '53000000-0000-4000-8000-000000000002',
        'Hacked service',
        now()
      );
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna_services insert allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- business_dna_services: cross-tenant update rejected (zero rows affected).
  update business_dna_services
  set name = 'Hacked'
  where organization_id = '52222222-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna_services update affected % row(s)', affected_rows;
  end if;

  -- business_dna_services: own-tenant update allowed.
  update business_dna_services
  set name = 'Updated by owner'
  where organization_id = '51111111-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: own-tenant business_dna_services update affected % row(s), expected 1', affected_rows;
  end if;

  -- business_dna_services: an org A writer, authorized to update their own
  -- service, cannot move it to org B via UPDATE ... SET organization_id.
  -- Same WITH CHECK hardening as business_dna above.
  begin
    update business_dna_services
    set organization_id = '52222222-0000-4000-8000-000000000000'
    where organization_id = '51111111-0000-4000-8000-000000000000';
    raise exception 'INBOX-DNA RLS FAIL: business_dna_services organization_id reassignment (A -> B) was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- business_dna_services: a guessed org B service id cannot be updated
  -- directly by primary key.
  update business_dna_services
  set name = 'Hijacked by guessed id'
  where id = '53500000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: guessed org B business_dna_services id was updatable, affected % row(s)', affected_rows;
  end if;

  -- business_dna_services: a guessed org B service id cannot be
  -- deactivated/reactivated directly by primary key either -- the same
  -- tenant boundary applies to a state-toggle write as to any other update.
  update business_dna_services
  set is_active = not is_active
  where id = '53500000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: guessed org B business_dna_services id was deactivatable, affected % row(s)', affected_rows;
  end if;

  -- business_dna_services: cross-tenant delete rejected (zero rows affected).
  delete from business_dna_services
  where organization_id = '52222222-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna_services delete affected % row(s)', affected_rows;
  end if;

  -- business_dna_services: own-tenant delete allowed for OWNER
  -- (business_dna_services_delete's role restriction), safely inside the
  -- rolled-back transaction.
  delete from business_dna_services
  where organization_id = '51111111-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: own-tenant business_dna_services delete affected % row(s), expected 1', affected_rows;
  end if;

  -- business_dna: cross-tenant delete rejected (zero rows affected).
  delete from business_dna
  where organization_id = '52222222-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'INBOX-DNA RLS FAIL: cross-tenant business_dna delete affected % row(s)', affected_rows;
  end if;

  -- business_dna: own-tenant delete allowed for OWNER (business_dna_delete's
  -- role restriction), safely inside the rolled-back transaction.
  delete from business_dna
  where organization_id = '51111111-0000-4000-8000-000000000000';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'INBOX-DNA RLS FAIL: own-tenant business_dna delete affected % row(s), expected 1', affected_rows;
  end if;

  -- inbox_threads: authenticated insert rejected -- proves RLS default-deny,
  -- not merely a missing grant (the role was explicitly granted INSERT above).
  begin
    insert into inbox_threads (organization_id, channel, updated_at)
      values ('51111111-0000-4000-8000-000000000000', 'EMAIL', now());
    raise exception 'INBOX-DNA RLS FAIL: authenticated insert into inbox_threads was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  raise notice 'ALL INBOX & BUSINESS DNA RLS ASSERTIONS PASSED';
end $$;

rollback;
