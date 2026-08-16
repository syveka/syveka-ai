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

-- 20260817000000_tenant_update_rls_with_check_hardening coverage: for every
-- hardened organization-owned table, prove (a) org A can update its own
-- row, (b) org A cannot reassign that row's organization_id to org B (WITH
-- CHECK rejects the resulting row), and (c) a guessed org B row cannot be
-- updated at all, by primary key, independent of any organization_id
-- filter. One shared helper keeps all 15 tables' assertions identical and
-- reviewable instead of repeating the same three checks by hand 15 times;
-- notifications is handled separately afterward since it is dual-owned
-- (organization_id AND user_id), not organization_id-only.
do $$
declare
  tbl text;
  id_a uuid;
  id_b uuid;
  affected_rows integer;
begin
  for tbl, id_a, id_b in
    values
      ('teams', 'c1000000-0000-4000-8000-000000000001'::uuid, 'c1000000-0000-4000-8000-000000000002'::uuid),
      ('companies', 'c2000000-0000-4000-8000-000000000001'::uuid, 'c2000000-0000-4000-8000-000000000002'::uuid),
      ('pipelines', 'c3000000-0000-4000-8000-000000000001'::uuid, 'c3000000-0000-4000-8000-000000000002'::uuid),
      ('deals', 'c4000000-0000-4000-8000-000000000001'::uuid, 'c4000000-0000-4000-8000-000000000002'::uuid),
      ('activities', 'c5000000-0000-4000-8000-000000000001'::uuid, 'c5000000-0000-4000-8000-000000000002'::uuid),
      ('tags', 'c6000000-0000-4000-8000-000000000001'::uuid, 'c6000000-0000-4000-8000-000000000002'::uuid),
      ('calendar_events', 'c7000000-0000-4000-8000-000000000001'::uuid, 'c7000000-0000-4000-8000-000000000002'::uuid),
      ('conversations', 'c8000000-0000-4000-8000-000000000001'::uuid, 'c8000000-0000-4000-8000-000000000002'::uuid),
      ('documents', 'c9000000-0000-4000-8000-000000000001'::uuid, 'c9000000-0000-4000-8000-000000000002'::uuid),
      ('collections', 'ca000000-0000-4000-8000-000000000001'::uuid, 'ca000000-0000-4000-8000-000000000002'::uuid),
      ('workflows', 'cb000000-0000-4000-8000-000000000001'::uuid, 'cb000000-0000-4000-8000-000000000002'::uuid),
      ('voice_assistants', 'cc000000-0000-4000-8000-000000000001'::uuid, 'cc000000-0000-4000-8000-000000000002'::uuid),
      ('webhook_endpoints', 'cd000000-0000-4000-8000-000000000001'::uuid, 'cd000000-0000-4000-8000-000000000002'::uuid),
      ('prompts', 'ce000000-0000-4000-8000-000000000001'::uuid, 'ce000000-0000-4000-8000-000000000002'::uuid)
  loop
    -- (a) own-tenant update allowed. `set id = id` is a genuine no-op
    -- UPDATE (still runs the full RLS USING/WITH CHECK machinery) that
    -- works uniformly across all 14 tables regardless of which optional
    -- columns each one happens to have (updatedAt exists on some of these
    -- models but not others -- id is the one column every table shares).
    execute format('update %I set id = id where id = $1', tbl) using id_a;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      raise exception 'TENANT-UPDATE FAIL: %.own-tenant update affected % row(s), expected 1', tbl, affected_rows;
    end if;

    -- (b) cannot reassign own row's organization_id to org B.
    begin
      execute format(
        'update %I set organization_id = ''22222222-0000-4000-8000-000000000000'' where id = $1',
        tbl
      ) using id_a;
      raise exception 'TENANT-UPDATE FAIL: %.organization_id reassignment (A -> B) was allowed', tbl;
    exception when insufficient_privilege or check_violation then
      null;
    end;

    -- (c) guessed org B row cannot be updated by id alone.
    execute format('update %I set id = id where id = $1', tbl) using id_b;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
      raise exception 'TENANT-UPDATE FAIL: guessed org B %.id was updatable, affected % row(s)', tbl, affected_rows;
    end if;
  end loop;

  raise notice 'ALL TENANT-UPDATE-HARDENING ASSERTIONS PASSED (organization_id-scoped tables)';
end $$;

-- notifications: dual-owned (organization_id AND user_id). Its own UPDATE
-- WITH CHECK (user_id = auth.uid() AND organization_id = auth_org_id())
-- mirrors notifications_select's predicate, not the generic
-- organization_id-only shape.
do $$
declare
  affected_rows integer;
begin
  -- own notification, own tenant: update allowed.
  update notifications set read_at = now() where id = 'cf000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'TENANT-UPDATE FAIL: notifications own-tenant update affected % row(s), expected 1', affected_rows;
  end if;

  -- cannot reassign own notification's organization_id to org B.
  begin
    update notifications
    set organization_id = '22222222-0000-4000-8000-000000000000'
    where id = 'cf000000-0000-4000-8000-000000000001';
    raise exception 'TENANT-UPDATE FAIL: notifications.organization_id reassignment (A -> B) was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  -- guessed org B notification id (belonging to org B's own user) cannot be
  -- updated by id alone.
  update notifications set read_at = now() where id = 'cf000000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'TENANT-UPDATE FAIL: guessed org B notifications.id was updatable, affected % row(s)', affected_rows;
  end if;

  raise notice 'ALL TENANT-UPDATE-HARDENING ASSERTIONS PASSED (notifications)';
end $$;

rollback;
