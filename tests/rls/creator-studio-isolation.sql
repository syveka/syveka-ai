-- Cross-tenant isolation assertions for Creator Studio tables (Phase 17 of
-- the Creator Studio mission; mirrors tests/rls/isolation.sql's shape and
-- guarantees). Fails loudly via exceptions.
--
-- Run directly as an already-authenticated, ephemeral LOGIN role that is a
-- member of `authenticated` -- see scripts/ci/run-rls-check.sh, which creates
-- that role, grants it privileges, and loads
-- tests/rls/creator-studio-fixtures.sql through a separate administrative
-- connection before this file ever runs. This file never creates a role,
-- never grants anything to itself, and never uses SET ROLE. Every attempted
-- write below happens inside a transaction that always rolls back; the
-- fixtures themselves are cleaned up separately, by the administrative
-- connection, after this file returns.

begin;

select set_config('request.jwt.claims', json_build_object(
  'sub', '71000000-0000-4000-8000-000000000001',
  'role', 'OWNER',
  'org_id', '71111111-0000-4000-8000-000000000000'
)::text, true);

-- creator_profiles: SELECT visibility, cross-tenant INSERT rejection, and
-- the full USING/WITH CHECK UPDATE triad (own-tenant update allowed,
-- reassignment to org B rejected, guessed org B row unreachable).
do $$
declare
  n int;
  affected_rows int;
begin
  select count(*) into n from creator_profiles;
  if n <> 1 then raise exception 'CS ISOLATION FAIL: expected 1 visible creator_profiles row, got %', n; end if;

  select count(*) into n from creator_profiles where id = 'd1000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'CS ISOLATION FAIL: cross-tenant creator_profiles row visible'; end if;

  begin
    insert into creator_profiles (organization_id, display_name, slug, created_at, updated_at)
      values ('72222222-0000-4000-8000-000000000000', 'Evil', 'evil-slug', now(), now());
    raise exception 'CS ISOLATION FAIL: cross-tenant creator_profiles insert allowed';
  exception when insufficient_privilege or check_violation then
    null; -- expected: RLS with check rejected it
  end;

  execute 'update creator_profiles set id = id where id = $1'
    using 'd1000000-0000-4000-8000-000000000001'::uuid;
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'CS TENANT-UPDATE FAIL: creator_profiles own-tenant update affected % row(s), expected 1', affected_rows;
  end if;

  begin
    update creator_profiles set organization_id = '72222222-0000-4000-8000-000000000000'
      where id = 'd1000000-0000-4000-8000-000000000001';
    raise exception 'CS TENANT-UPDATE FAIL: creator_profiles.organization_id reassignment (A -> B) was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  update creator_profiles set id = id where id = 'd1000000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'CS TENANT-UPDATE FAIL: guessed org B creator_profiles.id was updatable, affected % row(s)', affected_rows;
  end if;

  raise notice 'CREATOR_PROFILES ISOLATION + TENANT-UPDATE ASSERTIONS PASSED';
end $$;

-- creator_campaigns: identical shape to creator_profiles above.
do $$
declare
  n int;
  affected_rows int;
begin
  select count(*) into n from creator_campaigns;
  if n <> 1 then raise exception 'CS ISOLATION FAIL: expected 1 visible creator_campaigns row, got %', n; end if;

  select count(*) into n from creator_campaigns where id = 'd2000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'CS ISOLATION FAIL: cross-tenant creator_campaigns row visible'; end if;

  begin
    insert into creator_campaigns (organization_id, name, approval_mode, created_by_id, created_at, updated_at)
      values (
        '72222222-0000-4000-8000-000000000000', 'Evil Campaign', 'APPROVAL',
        '71000000-0000-4000-8000-000000000001', now(), now()
      );
    raise exception 'CS ISOLATION FAIL: cross-tenant creator_campaigns insert allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  update creator_campaigns set id = id where id = 'd2000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 1 then
    raise exception 'CS TENANT-UPDATE FAIL: creator_campaigns own-tenant update affected % row(s), expected 1', affected_rows;
  end if;

  begin
    update creator_campaigns set organization_id = '72222222-0000-4000-8000-000000000000'
      where id = 'd2000000-0000-4000-8000-000000000001';
    raise exception 'CS TENANT-UPDATE FAIL: creator_campaigns.organization_id reassignment (A -> B) was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  update creator_campaigns set id = id where id = 'd2000000-0000-4000-8000-000000000002';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'CS TENANT-UPDATE FAIL: guessed org B creator_campaigns.id was updatable, affected % row(s)', affected_rows;
  end if;

  raise notice 'CREATOR_CAMPAIGNS ISOLATION + TENANT-UPDATE ASSERTIONS PASSED';
end $$;

-- creator_generations, creator_templates, creator_posts: SELECT-only client
-- policies (server-service-only writes) -- cross-tenant visibility only.
do $$
declare n int;
begin
  select count(*) into n from creator_generations;
  if n <> 1 then raise exception 'CS ISOLATION FAIL: expected 1 visible creator_generations row, got %', n; end if;
  select count(*) into n from creator_generations where id = 'd3000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'CS ISOLATION FAIL: cross-tenant creator_generations row visible'; end if;

  -- global (organization_id null) + own-org template both visible; org B's is not.
  select count(*) into n from creator_templates
    where id in (
      'd4000000-0000-4000-8000-000000000000',
      'd4000000-0000-4000-8000-000000000001'
    );
  if n <> 2 then raise exception 'CS ISOLATION FAIL: expected global + own-org creator_templates rows visible, got %', n; end if;
  select count(*) into n from creator_templates where id = 'd4000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'CS ISOLATION FAIL: cross-tenant creator_templates row visible'; end if;

  select count(*) into n from creator_posts;
  if n <> 1 then raise exception 'CS ISOLATION FAIL: expected 1 visible creator_posts row, got %', n; end if;
  select count(*) into n from creator_posts where id = 'd5000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'CS ISOLATION FAIL: cross-tenant creator_posts row visible'; end if;

  raise notice 'CREATOR_GENERATIONS/TEMPLATES/POSTS SELECT-ONLY ISOLATION ASSERTIONS PASSED';
end $$;

rollback;
