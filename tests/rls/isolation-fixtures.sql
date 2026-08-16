-- Deterministic tenant fixtures for tests/rls/isolation.sql. Run by the
-- administrative connection via scripts/ci/run-rls-check.sh, which then runs
-- tests/rls/isolation.sql itself over a separate connection authenticated
-- directly as an ephemeral LOGIN role. This file intentionally has no
-- surrounding transaction: it must commit so that second, separate connection
-- (a different session entirely) can see these rows. Cleanup happens
-- afterward via tests/rls/isolation-cleanup.sql, not via rollback.
--
-- One row per organization for every table hardened by
-- 20260817000000_tenant_update_rls_with_check_hardening (plus contacts,
-- covered here since before that migration), so isolation.sql can exercise
-- the same cross-tenant UPDATE-reassignment and guessed-id assertions
-- documented in docs/security/RLS_UPDATE_WITH_CHECK_HARDENING.md for every
-- one of them.

delete from notifications
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from prompts
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from webhook_endpoints
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from voice_assistants
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from workflows
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from documents
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from collections
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from conversations
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from calendar_events
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from activities
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from deals
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from pipeline_stages
where pipeline_id in (
  select id from pipelines where organization_id in (
    '11111111-0000-4000-8000-000000000000',
    '22222222-0000-4000-8000-000000000000'
  )
);
delete from pipelines
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from tags
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from companies
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from teams
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
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

insert into teams (id, organization_id, name, created_at) values
  ('c1000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'Org A team', now()),
  ('c1000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'Org B team', now());

insert into companies (id, organization_id, name, created_at, updated_at) values
  ('c2000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'Org A co', now(), now()),
  ('c2000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'Org B co', now(), now());

insert into pipelines (id, organization_id, name) values
  ('c3000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'Org A pipeline'),
  ('c3000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'Org B pipeline');

insert into pipeline_stages (id, pipeline_id, name, "order") values
  ('c3100000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'Stage A', 0),
  ('c3100000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'Stage B', 0);

insert into tags (id, organization_id, name, color) values
  ('c6000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'Org A tag', '#6366f1'),
  ('c6000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'Org B tag', '#6366f1');

insert into deals (
  id, organization_id, pipeline_id, stage_id, title, created_at, updated_at
) values
  (
    'c4000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'c3000000-0000-4000-8000-000000000001',
    'c3100000-0000-4000-8000-000000000001',
    'Org A deal',
    now(),
    now()
  ),
  (
    'c4000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'c3000000-0000-4000-8000-000000000002',
    'c3100000-0000-4000-8000-000000000002',
    'Org B deal',
    now(),
    now()
  );

insert into activities (id, organization_id, type, subject, created_at) values
  ('c5000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'NOTE', 'Org A activity', now()),
  ('c5000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'NOTE', 'Org B activity', now());

insert into calendar_events (
  id, organization_id, created_by_id, title, starts_at, ends_at, updated_at
) values
  (
    'c7000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'Org A event',
    now(),
    now() + interval '1 hour',
    now()
  ),
  (
    'c7000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'b0000000-0000-4000-8000-000000000002',
    'Org B event',
    now(),
    now() + interval '1 hour',
    now()
  );

insert into conversations (id, organization_id, user_id, title, created_at, updated_at) values
  (
    'c8000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'Org A conversation',
    now(),
    now()
  ),
  (
    'c8000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'b0000000-0000-4000-8000-000000000002',
    'Org B conversation',
    now(),
    now()
  );

insert into collections (id, organization_id, name, created_at) values
  ('ca000000-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000000', 'Org A collection', now()),
  ('ca000000-0000-4000-8000-000000000002', '22222222-0000-4000-8000-000000000000', 'Org B collection', now());

insert into documents (
  id, organization_id, uploaded_by_id, title, source_type, created_at, updated_at
) values
  (
    'c9000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'Org A document',
    'NOTE',
    now(),
    now()
  ),
  (
    'c9000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'b0000000-0000-4000-8000-000000000002',
    'Org B document',
    'NOTE',
    now(),
    now()
  );

insert into workflows (
  id, organization_id, created_by_id, name, trigger, steps, created_at, updated_at
) values
  (
    'cb000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'Org A workflow',
    '{}'::jsonb,
    '[]'::jsonb,
    now(),
    now()
  ),
  (
    'cb000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'b0000000-0000-4000-8000-000000000002',
    'Org B workflow',
    '{}'::jsonb,
    '[]'::jsonb,
    now(),
    now()
  );

insert into voice_assistants (
  id, organization_id, name, first_message, system_prompt, created_at, updated_at
) values
  (
    'cc000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'Org A assistant',
    'Hi!',
    'You are helpful.',
    now(),
    now()
  ),
  (
    'cc000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'Org B assistant',
    'Hi!',
    'You are helpful.',
    now(),
    now()
  );

insert into webhook_endpoints (id, organization_id, url, secret, events, created_at) values
  (
    'cd000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'https://a.example.com/hook',
    'secret-a',
    ARRAY['deal.updated'],
    now()
  ),
  (
    'cd000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'https://b.example.com/hook',
    'secret-b',
    ARRAY['deal.updated'],
    now()
  );

insert into prompts (id, organization_id, title, content, created_at, updated_at) values
  (
    'ce000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'Org A prompt',
    'Draft a reply.',
    now(),
    now()
  ),
  (
    'ce000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'Org B prompt',
    'Draft a reply.',
    now(),
    now()
  );

insert into notifications (id, organization_id, user_id, type, title, created_at) values
  (
    'cf000000-0000-4000-8000-000000000001',
    '11111111-0000-4000-8000-000000000000',
    'a0000000-0000-4000-8000-000000000001',
    'info',
    'Org A notification',
    now()
  ),
  (
    'cf000000-0000-4000-8000-000000000002',
    '22222222-0000-4000-8000-000000000000',
    'b0000000-0000-4000-8000-000000000002',
    'info',
    'Org B notification',
    now()
  );
