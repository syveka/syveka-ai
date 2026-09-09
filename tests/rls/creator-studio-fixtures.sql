-- Deterministic tenant fixtures for tests/rls/creator-studio-isolation.sql.
-- Run by the administrative connection via scripts/ci/run-rls-check.sh, which
-- then runs tests/rls/creator-studio-isolation.sql itself over a separate
-- connection authenticated directly as an ephemeral LOGIN role. No
-- surrounding transaction: it must commit so that second, separate
-- connection can see these rows. Cleanup happens afterward via
-- tests/rls/creator-studio-cleanup.sql, not via rollback.

delete from creator_posts
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_templates
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_generations
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_campaigns
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_profiles
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from organization_members
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from organizations
where id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  '71000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '71000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002'
);

-- The auth trigger mirrors these rows into public.users.
insert into auth.users (id, email, raw_user_meta_data) values
  ('71000000-0000-4000-8000-000000000001', 'creator-studio-a@test.invalid', '{}'::jsonb),
  ('72000000-0000-4000-8000-000000000002', 'creator-studio-b@test.invalid', '{}'::jsonb);

insert into organizations (id, name, slug, created_at, updated_at) values
  ('71111111-0000-4000-8000-000000000000', 'Creator Studio Org A', 'creator-studio-org-a', now(), now()),
  ('72222222-0000-4000-8000-000000000000', 'Creator Studio Org B', 'creator-studio-org-b', now(), now())
on conflict (id) do update set
  name = excluded.name,
  slug = excluded.slug,
  updated_at = now();

insert into organization_members (organization_id, user_id, role) values
  ('71111111-0000-4000-8000-000000000000', '71000000-0000-4000-8000-000000000001', 'OWNER'),
  ('72222222-0000-4000-8000-000000000000', '72000000-0000-4000-8000-000000000002', 'OWNER')
on conflict (organization_id, user_id) do update set
  role = excluded.role;

insert into creator_profiles (
  id, organization_id, display_name, slug, status, created_at, updated_at
) values
  (
    'd1000000-0000-4000-8000-000000000001',
    '71111111-0000-4000-8000-000000000000',
    'Org A Creator', 'org-a-creator', 'ACTIVE', now(), now()
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    '72222222-0000-4000-8000-000000000000',
    'Org B Creator', 'org-b-creator', 'ACTIVE', now(), now()
  );

insert into creator_campaigns (
  id, organization_id, name, approval_mode, created_by_id, created_at, updated_at
) values
  (
    'd2000000-0000-4000-8000-000000000001',
    '71111111-0000-4000-8000-000000000000',
    'Org A Campaign', 'APPROVAL', '71000000-0000-4000-8000-000000000001', now(), now()
  ),
  (
    'd2000000-0000-4000-8000-000000000002',
    '72222222-0000-4000-8000-000000000000',
    'Org B Campaign', 'APPROVAL', '72000000-0000-4000-8000-000000000002', now(), now()
  );

insert into creator_generations (
  id, organization_id, creator_profile_id, generation_type, provider, model,
  prompt, status, created_by_id, created_at
) values
  (
    'd3000000-0000-4000-8000-000000000001',
    '71111111-0000-4000-8000-000000000000',
    'd1000000-0000-4000-8000-000000000001',
    'IMAGE', 'mock', 'default', 'Org A prompt', 'COMPLETED',
    '71000000-0000-4000-8000-000000000001', now()
  ),
  (
    'd3000000-0000-4000-8000-000000000002',
    '72222222-0000-4000-8000-000000000000',
    'd1000000-0000-4000-8000-000000000002',
    'IMAGE', 'mock', 'default', 'Org B prompt', 'COMPLETED',
    '72000000-0000-4000-8000-000000000002', now()
  );

-- A global template (organization_id null) plus one org-owned template, to
-- exercise creator_templates_select's "organization_id IS NULL OR
-- organization_id = auth_org_id()" predicate.
insert into creator_templates (
  id, organization_id, name, slug, category, prompt_template, generation_type,
  aspect_ratio, created_at, updated_at
) values
  (
    'd4000000-0000-4000-8000-000000000000',
    null,
    'Global Template', 'creator-studio-rls-global-template', 'Business',
    'A global template prompt.', 'IMAGE', '1:1', now(), now()
  ),
  (
    'd4000000-0000-4000-8000-000000000001',
    '71111111-0000-4000-8000-000000000000',
    'Org A Template', 'org-a-rls-template', 'Business',
    'An org-owned template prompt.', 'IMAGE', '1:1', now(), now()
  ),
  (
    'd4000000-0000-4000-8000-000000000002',
    '72222222-0000-4000-8000-000000000000',
    'Org B Template', 'org-b-rls-template', 'Business',
    'An org-owned template prompt.', 'IMAGE', '1:1', now(), now()
  );

insert into creator_posts (
  id, organization_id, creator_profile_id, platform, approval_status,
  created_by_id, created_at, updated_at
) values
  (
    'd5000000-0000-4000-8000-000000000001',
    '71111111-0000-4000-8000-000000000000',
    'd1000000-0000-4000-8000-000000000001',
    'INSTAGRAM', 'DRAFT', '71000000-0000-4000-8000-000000000001', now(), now()
  ),
  (
    'd5000000-0000-4000-8000-000000000002',
    '72222222-0000-4000-8000-000000000000',
    'd1000000-0000-4000-8000-000000000002',
    'INSTAGRAM', 'DRAFT', '72000000-0000-4000-8000-000000000002', now(), now()
  );
