-- Calendar & Booking RLS catalog and tenant-behavior assertions.
-- Runs after prisma db push, base RLS setup, and the tracked RLS migration.

begin;

do $$
declare
  enabled_count integer;
  policy_count integer;
begin
  select count(*) into enabled_count
  from pg_class
  where oid in (
    'public.event_attendees'::regclass,
    'public.calendar_connections'::regclass,
    'public.external_calendars'::regclass,
    'public.calendar_sync_states'::regclass,
    'public.availability_schedules'::regclass,
    'public.availability_rules'::regclass,
    'public.availability_overrides'::regclass,
    'public.booking_types'::regclass,
    'public.bookings'::regclass,
    'public.booking_tokens'::regclass,
    'public.reminders'::regclass
  )
    and relrowsecurity;

  if enabled_count <> 11 then
    raise exception 'CALENDAR RLS FAIL: expected RLS on 11 tables, found %', enabled_count;
  end if;

  select count(*) into policy_count
  from (
    values
      ('external_calendars', 'external_calendars_select'),
      ('availability_schedules', 'availability_schedules_select'),
      ('booking_types', 'booking_types_select'),
      ('bookings', 'bookings_select'),
      ('event_attendees', 'event_attendees_select'),
      ('availability_rules', 'availability_rules_select'),
      ('availability_overrides', 'availability_overrides_select')
  ) as expected(tablename, policyname)
  join pg_policies as policy
    on policy.schemaname = 'public'
   and policy.tablename = expected.tablename
   and policy.policyname = expected.policyname
   and policy.cmd = 'SELECT'
   and policy.roles @> array['authenticated']::name[];

  if policy_count <> 7 then
    raise exception 'CALENDAR RLS FAIL: expected 7 authenticated SELECT policies, found %', policy_count;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (
        array[
          'calendar_connections',
          'booking_tokens',
          'reminders',
          'calendar_sync_states'
        ]
      )
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'CALENDAR RLS FAIL: authenticated policy exists on a server-only table';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (
        array[
          'event_attendees',
          'calendar_connections',
          'external_calendars',
          'calendar_sync_states',
          'availability_schedules',
          'availability_rules',
          'availability_overrides',
          'booking_types',
          'bookings',
          'booking_tokens',
          'reminders'
        ]
      )
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'CALENDAR RLS FAIL: authenticated client write policy exists';
  end if;
end $$;

-- Deterministic tenant fixtures. The surrounding transaction always rolls
-- back, including cleanup and any test role created below.
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

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'calendar_authenticated_test') then
    create role calendar_authenticated_test login;
  end if;
end $$;
grant authenticated to calendar_authenticated_test;
grant usage on schema public to calendar_authenticated_test;
grant select, insert, update, delete on all tables in schema public to calendar_authenticated_test;

set role calendar_authenticated_test;
select set_config('request.jwt.claims', json_build_object(
  'sub', 'c0000000-0000-4000-8000-000000000001',
  'role', 'OWNER',
  'org_id', '31111111-0000-4000-8000-000000000000'
)::text, true);

do $$
declare
  affected_rows integer;
  table_name text;
begin
  foreach table_name in array array[
    'external_calendars',
    'availability_schedules',
    'booking_types',
    'bookings',
    'event_attendees',
    'availability_rules',
    'availability_overrides'
  ] loop
    execute format('select count(*) from public.%I', table_name) into affected_rows;
    if affected_rows <> 1 then
      raise exception 'CALENDAR RLS FAIL: expected 1 visible own-tenant row in %, got %',
        table_name,
        affected_rows;
    end if;
  end loop;

  foreach table_name in array array[
    'calendar_connections',
    'booking_tokens',
    'reminders',
    'calendar_sync_states'
  ] loop
    execute format('select count(*) from public.%I', table_name) into affected_rows;
    if affected_rows <> 0 then
      raise exception 'CALENDAR RLS FAIL: server-only table % exposed % rows',
        table_name,
        affected_rows;
    end if;
  end loop;

  begin
    insert into availability_schedules (
      organization_id, user_id, name, updated_at
    ) values (
      '31111111-0000-4000-8000-000000000000',
      'c0000000-0000-4000-8000-000000000001',
      'Forbidden client insert',
      now()
    );
    raise exception 'CALENDAR RLS FAIL: authenticated insert was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  update booking_types
  set name = 'Forbidden client update'
  where id = 'c7000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'CALENDAR RLS FAIL: authenticated update changed % rows', affected_rows;
  end if;

  delete from availability_rules
  where id = 'c5000000-0000-4000-8000-000000000001';
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'CALENDAR RLS FAIL: authenticated delete removed % rows', affected_rows;
  end if;

  begin
    insert into calendar_connections (
      organization_id, user_id, provider, updated_at
    ) values (
      '31111111-0000-4000-8000-000000000000',
      'c0000000-0000-4000-8000-000000000001',
      'GOOGLE',
      now()
    );
    raise exception 'CALENDAR RLS FAIL: authenticated server-only insert was allowed';
  exception when insufficient_privilege or check_violation then
    null;
  end;

  raise notice 'ALL CALENDAR & BOOKING RLS ASSERTIONS PASSED';
end $$;

reset role;
rollback;
