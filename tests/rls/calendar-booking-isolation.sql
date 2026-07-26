-- Calendar & Booking RLS catalog and tenant-behavior assertions.
--
-- Run directly as an already-authenticated, ephemeral LOGIN role that is a
-- member of `authenticated` -- see scripts/ci/run-rls-check.sh, which creates
-- that role, grants it privileges, and loads
-- tests/rls/calendar-booking-fixtures.sql through a separate administrative
-- connection before this file ever runs. This file never creates a role,
-- never grants anything to itself, and never uses SET ROLE: the connection
-- this runs over IS the client role for real. Every attempted write below
-- happens inside a transaction that always rolls back; the fixtures
-- themselves are cleaned up separately, by the administrative connection,
-- after this file returns.

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

begin;

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

rollback;
