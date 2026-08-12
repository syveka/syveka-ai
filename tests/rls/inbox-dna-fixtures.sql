-- Deterministic tenant fixtures for tests/rls/inbox-dna-isolation.sql. Run by
-- the administrative connection via scripts/ci/run-rls-check.sh, which then
-- runs tests/rls/inbox-dna-isolation.sql itself over a separate connection
-- authenticated directly as an ephemeral LOGIN role. This file intentionally
-- has no surrounding transaction: it must commit so that second, separate
-- connection (a different session entirely) can see these rows. Cleanup
-- happens afterward via tests/rls/inbox-dna-cleanup.sql, not via rollback.

delete from inbox_messages
where thread_id in (
  select id from inbox_threads
  where organization_id in (
    '51111111-0000-4000-8000-000000000000',
    '52222222-0000-4000-8000-000000000000'
  )
);
delete from inbox_threads
where organization_id in (
  '51111111-0000-4000-8000-000000000000',
  '52222222-0000-4000-8000-000000000000'
);
delete from inbox_mailboxes
where organization_id in (
  '51111111-0000-4000-8000-000000000000',
  '52222222-0000-4000-8000-000000000000'
);
delete from business_dna
where organization_id in (
  '51111111-0000-4000-8000-000000000000',
  '52222222-0000-4000-8000-000000000000'
);
delete from organizations
where id in (
  '51111111-0000-4000-8000-000000000000',
  '52222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  'e0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'e0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002'
);

insert into auth.users (id, email, raw_user_meta_data) values
  ('e0000000-0000-4000-8000-000000000001', 'inbox-dna-a@test.invalid', '{}'::jsonb),
  ('f0000000-0000-4000-8000-000000000002', 'inbox-dna-b@test.invalid', '{}'::jsonb);

insert into organizations (id, name, slug, created_at, updated_at) values
  ('51111111-0000-4000-8000-000000000000', 'Inbox DNA Org A', 'inbox-dna-org-a', now(), now()),
  ('52222222-0000-4000-8000-000000000000', 'Inbox DNA Org B', 'inbox-dna-org-b', now(), now());

insert into organization_members (organization_id, user_id, role) values
  ('51111111-0000-4000-8000-000000000000', 'e0000000-0000-4000-8000-000000000001', 'OWNER'),
  ('52222222-0000-4000-8000-000000000000', 'f0000000-0000-4000-8000-000000000002', 'OWNER');

insert into business_dna (
  id, organization_id, display_name, updated_at
) values
  (
    '53000000-0000-4000-8000-000000000001',
    '51111111-0000-4000-8000-000000000000',
    'Inbox DNA Org A',
    now()
  ),
  (
    '53000000-0000-4000-8000-000000000002',
    '52222222-0000-4000-8000-000000000000',
    'Inbox DNA Org B',
    now()
  );

insert into inbox_mailboxes (
  id, organization_id, channel, address, updated_at
) values
  (
    '54000000-0000-4000-8000-000000000001',
    '51111111-0000-4000-8000-000000000000',
    'EMAIL',
    'inbox-dna-a@mail.test.invalid',
    now()
  ),
  (
    '54000000-0000-4000-8000-000000000002',
    '52222222-0000-4000-8000-000000000000',
    'EMAIL',
    'inbox-dna-b@mail.test.invalid',
    now()
  );

insert into inbox_threads (
  id, organization_id, channel, status, subject, updated_at
) values
  (
    '55000000-0000-4000-8000-000000000001',
    '51111111-0000-4000-8000-000000000000',
    'EMAIL',
    'OPEN',
    'Thread A',
    now()
  ),
  (
    '55000000-0000-4000-8000-000000000002',
    '52222222-0000-4000-8000-000000000000',
    'EMAIL',
    'OPEN',
    'Thread B',
    now()
  );

insert into inbox_messages (
  id, thread_id, direction, status, body, updated_at
) values
  (
    '56000000-0000-4000-8000-000000000001',
    '55000000-0000-4000-8000-000000000001',
    'INBOUND',
    'RECEIVED',
    'Hello from Org A customer',
    now()
  ),
  (
    '56000000-0000-4000-8000-000000000002',
    '55000000-0000-4000-8000-000000000002',
    'INBOUND',
    'RECEIVED',
    'Hello from Org B customer',
    now()
  );
