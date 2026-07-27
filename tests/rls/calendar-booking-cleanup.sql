-- Removes exactly the fixtures tests/rls/calendar-booking-fixtures.sql
-- creates, then verifies they are actually gone -- this file fails loudly
-- (raises an exception, giving scripts/ci/run-rls-check.sh a non-zero exit)
-- rather than merely reporting that its DELETE statements executed without
-- error. Run by the administrative connection, via the harness's exit trap,
-- after the client-side assertions in tests/rls/calendar-booking-isolation.sql
-- complete -- whether they passed, failed, or the client connection itself
-- never succeeded. Deleting the two organizations cascades to every other
-- fixture row created above (calendar_connections, external_calendars,
-- calendar_sync_states, availability_schedules/rules/overrides,
-- booking_types, calendar_events, event_attendees, bookings, booking_tokens,
-- reminders all reference organization_id with ON DELETE CASCADE), so
-- verifying the two organizations are gone is sufficient to verify the whole
-- fixture set is gone.

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

do $$
declare remaining int;
begin
  select count(*) into remaining
  from organizations
  where id in (
    '31111111-0000-4000-8000-000000000000',
    '32222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'CALENDAR-BOOKING CLEANUP FAIL: % organization fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from users
  where id in (
    'c0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000002'
  );
  if remaining <> 0 then
    raise exception 'CALENDAR-BOOKING CLEANUP FAIL: % user fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from calendar_connections
  where organization_id in (
    '31111111-0000-4000-8000-000000000000',
    '32222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'CALENDAR-BOOKING CLEANUP FAIL: % calendar_connections fixture row(s) remain (cascade did not run)', remaining;
  end if;
end $$;
