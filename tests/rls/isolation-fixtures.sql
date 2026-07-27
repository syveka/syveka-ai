-- Deterministic tenant fixtures for tests/rls/isolation.sql. Run by the
-- administrative connection via scripts/ci/run-rls-check.sh, which then runs
-- tests/rls/isolation.sql itself over a separate connection authenticated
-- directly as an ephemeral LOGIN role. This file intentionally has no
-- surrounding transaction: it must commit so that second, separate connection
-- (a different session entirely) can see these rows. Cleanup happens
-- afterward via tests/rls/isolation-cleanup.sql, not via rollback.

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
