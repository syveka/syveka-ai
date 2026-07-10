-- Cross-tenant isolation assertions (§4.3, §23).
-- Runs against a migrated DB with policies applied. Fails loudly via exceptions.

begin;

-- Fixtures: two orgs, one user each
delete from contacts
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from subscriptions
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from organization_members
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from organizations
where id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002'
);

-- The auth trigger mirrors these rows into public.users.
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'a@test.fi', '{}'::jsonb),
  ('b0000000-0000-4000-8000-000000000002', 'b@test.fi', '{}'::jsonb);

insert into organizations (id, name, slug, created_at, updated_at) values
  ('11111111-0000-4000-8000-000000000000', 'Org A', 'org-a', now(), now()),
  ('22222222-0000-4000-8000-000000000000', 'Org B', 'org-b', now(), now())
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  updated_at = now();

insert into organization_members (organization_id, user_id, role) values
  ('11111111-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000001', 'OWNER'),
  ('22222222-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000002', 'OWNER')
on conflict (organization_id, user_id) do update set
  role = excluded.role;

insert into contacts (organization_id, first_name, email, created_at, updated_at) values
  ('11111111-0000-4000-8000-000000000000', 'Aino', 'aino@a.fi', now(), now()),
  ('22222222-0000-4000-8000-000000000000', 'Bertta', 'bertta@b.fi', now(), now());

-- Simulate an authenticated session for user A / org A
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated_test') then
    create role authenticated_test login;
  end if;
end $$;
grant authenticated to authenticated_test;
grant usage on schema public to authenticated_test;
grant select, insert, update, delete on all tables in schema public to authenticated_test;

set role authenticated_test;
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

reset role;
rollback;
