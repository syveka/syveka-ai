-- Deterministic tenant fixtures for tests/rls/calendar-booking-isolation.sql.
-- Run by the administrative connection via scripts/ci/run-rls-check.sh, which
-- then runs tests/rls/calendar-booking-isolation.sql itself over a separate
-- connection authenticated directly as an ephemeral LOGIN role. This file
-- intentionally has no surrounding transaction: it must commit so that
-- second, separate connection (a different session entirely) can see these
-- rows. Cleanup happens afterward via
-- tests/rls/calendar-booking-cleanup.sql, not via rollback.

delete from organizations
where id in (
  '31111111-0000-4000-8000-000000000000',
  '32222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  'c0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'c0000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000002'
);

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000000-0000-4000-8000-000000000001', 'calendar-a@test.invalid', '{}'::jsonb),
  ('d0000000-0000-4000-8000-000000000002', 'calendar-b@test.invalid', '{}'::jsonb);

insert into organizations (id, name, slug, created_at, updated_at) values
  ('31111111-0000-4000-8000-000000000000', 'Calendar Org A', 'calendar-org-a', now(), now()),
  ('32222222-0000-4000-8000-000000000000', 'Calendar Org B', 'calendar-org-b', now(), now());

insert into organization_members (organization_id, user_id, role) values
  ('31111111-0000-4000-8000-000000000000', 'c0000000-0000-4000-8000-000000000001', 'OWNER'),
  ('32222222-0000-4000-8000-000000000000', 'd0000000-0000-4000-8000-000000000002', 'OWNER');

insert into calendar_connections (
  id, organization_id, user_id, provider, account_email, updated_at
) values
  (
    'c1000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c0000000-0000-4000-8000-000000000001',
    'MOCK',
    'calendar-a@test.invalid',
    now()
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd0000000-0000-4000-8000-000000000002',
    'MOCK',
    'calendar-b@test.invalid',
    now()
  );

insert into external_calendars (
  id, connection_id, organization_id, external_id, name
) values
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'external-a',
    'Calendar A'
  ),
  (
    'd2000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'external-b',
    'Calendar B'
  );

insert into calendar_sync_states (
  id, organization_id, external_calendar_id, sync_cursor, updated_at
) values
  (
    'c3000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c2000000-0000-4000-8000-000000000001',
    'cursor-a',
    now()
  ),
  (
    'd3000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd2000000-0000-4000-8000-000000000002',
    'cursor-b',
    now()
  );

insert into availability_schedules (
  id, organization_id, user_id, name, updated_at
) values
  (
    'c4000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c0000000-0000-4000-8000-000000000001',
    'Availability A',
    now()
  ),
  (
    'd4000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd0000000-0000-4000-8000-000000000002',
    'Availability B',
    now()
  );

insert into availability_rules (id, schedule_id, weekday, start_minute, end_minute) values
  ('c5000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 1, 540, 1020),
  ('d5000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', 1, 540, 1020);

insert into availability_overrides (
  id, schedule_id, date, is_unavailable
) values
  ('c6000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', date '2030-01-01', true),
  ('d6000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000002', date '2030-01-01', true);

insert into booking_types (
  id, organization_id, owner_id, schedule_id, slug, name, updated_at
) values
  (
    'c7000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c0000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'booking-a',
    'Booking A',
    now()
  ),
  (
    'd7000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd0000000-0000-4000-8000-000000000002',
    'd4000000-0000-4000-8000-000000000002',
    'booking-b',
    'Booking B',
    now()
  );

insert into calendar_events (
  id, organization_id, created_by_id, title, starts_at, ends_at, updated_at
) values
  (
    'c8000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c0000000-0000-4000-8000-000000000001',
    'Event A',
    timestamptz '2030-01-01 10:00:00+00',
    timestamptz '2030-01-01 10:30:00+00',
    now()
  ),
  (
    'd8000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd0000000-0000-4000-8000-000000000002',
    'Event B',
    timestamptz '2030-01-01 11:00:00+00',
    timestamptz '2030-01-01 11:30:00+00',
    now()
  );

insert into event_attendees (id, event_id, email) values
  ('c9000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'attendee-a@test.invalid'),
  ('d9000000-0000-4000-8000-000000000002', 'd8000000-0000-4000-8000-000000000002', 'attendee-b@test.invalid');

insert into bookings (
  id, organization_id, booking_type_id, event_id, guest_name, guest_email,
  starts_at, ends_at, updated_at
) values
  (
    'ca000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c7000000-0000-4000-8000-000000000001',
    'c8000000-0000-4000-8000-000000000001',
    'Guest A',
    'guest-a@test.invalid',
    timestamptz '2030-01-01 10:00:00+00',
    timestamptz '2030-01-01 10:30:00+00',
    now()
  ),
  (
    'da000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd7000000-0000-4000-8000-000000000002',
    'd8000000-0000-4000-8000-000000000002',
    'Guest B',
    'guest-b@test.invalid',
    timestamptz '2030-01-01 11:00:00+00',
    timestamptz '2030-01-01 11:30:00+00',
    now()
  );

insert into booking_tokens (
  id, booking_id, token_hash, purpose, expires_at
) values
  (
    'cb000000-0000-4000-8000-000000000001',
    'ca000000-0000-4000-8000-000000000001',
    'calendar-booking-token-a',
    'MANAGE',
    now() + interval '1 day'
  ),
  (
    'db000000-0000-4000-8000-000000000002',
    'da000000-0000-4000-8000-000000000002',
    'calendar-booking-token-b',
    'MANAGE',
    now() + interval '1 day'
  );

insert into reminders (
  id, organization_id, event_id, send_at, dedupe_key
) values
  (
    'cc000000-0000-4000-8000-000000000001',
    '31111111-0000-4000-8000-000000000000',
    'c8000000-0000-4000-8000-000000000001',
    timestamptz '2030-01-01 09:00:00+00',
    'calendar-reminder-a'
  ),
  (
    'dc000000-0000-4000-8000-000000000002',
    '32222222-0000-4000-8000-000000000000',
    'd8000000-0000-4000-8000-000000000002',
    timestamptz '2030-01-01 10:00:00+00',
    'calendar-reminder-b'
  );
