-- Cross-tenant isolation assertions (§4.3, §23). Fails loudly via exceptions.
--
-- Run directly as an already-authenticated, ephemeral LOGIN role that is a
-- member of `authenticated` -- see scripts/ci/run-rls-check.sh, which creates
-- that role, grants it privileges, and loads tests/rls/isolation-fixtures.sql
-- through a separate administrative connection before this file ever runs.
-- This file never creates a role, never grants anything to itself, and never
-- uses SET ROLE: the connection this runs over IS the client role for real,
-- which is what makes these assertions genuine (and what keeps them working
-- against a hosted Postgres that terminates a connection attempting to grant
-- itself a new role -- see this file's git history for the investigation).
-- Every attempted write below happens inside a transaction that always rolls
-- back; the fixtures themselves are cleaned up separately, by the
-- administrative connection, after this file returns.

begin;

select set_config('request.jwt.claims', json_build_object(
  'sub', 'a0000000-0000-4000-8000-000000000001',
  'role', 'OWNER',
  'org_id', '11111111-0000-4000-8000-000000000000'
)::text, true);

do $$
declare n int;
begin
  -- 1. sees own contacts
  select count(*) into n from contacts;
  if n <> 1 then raise exception 'ISOLATION FAIL: expected 1 visible contact, got %', n; end if;

  -- 2. cannot see org B's contact
  select count(*) into n from contacts where email = 'bertta@b.fi';
  if n <> 0 then raise exception 'ISOLATION FAIL: cross-tenant contact visible'; end if;

  -- 3. cannot see org B row in organizations
  select count(*) into n from organizations where id = '22222222-0000-4000-8000-000000000000';
  if n <> 0 then raise exception 'ISOLATION FAIL: foreign organization visible'; end if;

  -- 4. cannot insert into org B
  begin
    insert into contacts (organization_id, first_name, created_at, updated_at)
      values ('22222222-0000-4000-8000-000000000000', 'Evil', now(), now());
    raise exception 'ISOLATION FAIL: cross-tenant insert allowed';
  exception when insufficient_privilege or check_violation then
    null; -- expected: RLS with check rejected it
  end;

  -- 5. subscriptions are read-only from client role
  begin
    insert into subscriptions (organization_id, plan, status, seats, created_at, updated_at)
      values ('11111111-0000-4000-8000-000000000000', 'PRO', 'ACTIVE', 1, now(), now());
    raise exception 'ISOLATION FAIL: client-side subscription insert allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  raise notice 'ALL RLS ISOLATION ASSERTIONS PASSED';
end $$;

rollback;
