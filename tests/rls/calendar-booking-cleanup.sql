-- Removes exactly the fixtures tests/rls/calendar-booking-fixtures.sql
-- creates. Run by the administrative connection, via
-- scripts/ci/run-rls-check.sh's exit trap, after the client-side assertions
-- in tests/rls/calendar-booking-isolation.sql complete -- whether they
-- passed, failed, or the client connection itself never succeeded. Deleting
-- the two organizations cascades to every other fixture row created above
-- (calendar_connections, external_calendars, calendar_sync_states,
-- availability_schedules/rules/overrides, booking_types, calendar_events,
-- event_attendees, bookings, booking_tokens, reminders all reference
-- organization_id with ON DELETE CASCADE).

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
