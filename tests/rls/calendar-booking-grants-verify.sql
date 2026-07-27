-- Verifies the ephemeral role for the calendar-booking suite has EXACTLY the
-- table privileges tests/rls/calendar-booking-grants.sql grants -- no more
-- and no less. Run by scripts/ci/run-rls-check.sh immediately after granting
-- privileges and before loading fixtures, via `psql -v role_name=...`.
--
-- psql's :"var"/:'var' substitution does not apply inside a $$...$$
-- dollar-quoted block (the whole point of dollar-quoting is that psql does
-- not preprocess its contents), so :'role_name' is resolved here, at the top
-- level, into a session setting the DO block below reads back with
-- current_setting() -- not referenced directly inside the block itself.
select set_config('rls_check.role_name', :'role_name', false);

do $$
declare
  target_role text := current_setting('rls_check.role_name');
  extra_count int;
  missing_count int;
begin
  select count(*) into extra_count
  from information_schema.role_table_grants
  where grantee = target_role
    and table_schema = 'public'
    and (table_name, privilege_type) not in (
      ('external_calendars', 'SELECT'),
      ('bookings', 'SELECT'),
      ('event_attendees', 'SELECT'),
      ('calendar_events', 'SELECT'),
      ('availability_overrides', 'SELECT'),
      ('availability_schedules', 'SELECT'), ('availability_schedules', 'INSERT'),
      ('booking_types', 'SELECT'), ('booking_types', 'UPDATE'),
      ('availability_rules', 'SELECT'), ('availability_rules', 'DELETE'),
      ('booking_tokens', 'SELECT'),
      ('reminders', 'SELECT'),
      ('calendar_sync_states', 'SELECT'),
      ('calendar_connections', 'SELECT'), ('calendar_connections', 'INSERT')
    );
  if extra_count <> 0 then
    raise exception 'CALENDAR-BOOKING PRIVILEGE ALLOWLIST FAIL: % privilege(s) granted beyond the allowlist', extra_count;
  end if;

  select count(*) into missing_count
  from (
    values
      ('external_calendars', 'SELECT'),
      ('bookings', 'SELECT'),
      ('event_attendees', 'SELECT'),
      ('calendar_events', 'SELECT'),
      ('availability_overrides', 'SELECT'),
      ('availability_schedules', 'SELECT'), ('availability_schedules', 'INSERT'),
      ('booking_types', 'SELECT'), ('booking_types', 'UPDATE'),
      ('availability_rules', 'SELECT'), ('availability_rules', 'DELETE'),
      ('booking_tokens', 'SELECT'),
      ('reminders', 'SELECT'),
      ('calendar_sync_states', 'SELECT'),
      ('calendar_connections', 'SELECT'), ('calendar_connections', 'INSERT')
  ) as expected(table_name, privilege_type)
  where not exists (
    select 1
    from information_schema.role_table_grants as g
    where g.grantee = target_role
      and g.table_schema = 'public'
      and g.table_name = expected.table_name
      and g.privilege_type = expected.privilege_type
  );
  if missing_count <> 0 then
    raise exception 'CALENDAR-BOOKING PRIVILEGE ALLOWLIST FAIL: % expected privilege(s) missing', missing_count;
  end if;
end $$;
