-- Exact per-table privileges tests/rls/calendar-booking-isolation.sql's
-- client assertions require -- deliberately narrower than "all tables in
-- schema public":
--   - external_calendars, bookings, event_attendees, availability_overrides:
--       SELECT only (own-tenant visibility; no write ever attempted).
--   - calendar_events: SELECT only. Never queried directly by the client
--       assertions, but event_attendees_select's own RLS policy joins to
--       calendar_events to resolve tenant ownership, so the role needs SELECT
--       there too or RLS policy evaluation itself fails with a plain
--       permission error before ever reaching the assertion.
--   - availability_schedules: SELECT (own-tenant visibility) and INSERT
--       (proves RLS's WITH CHECK, not a missing grant, rejects the client
--       insert).
--   - booking_types: SELECT (own-tenant visibility) and UPDATE (proves RLS,
--       not a missing grant, leaves the client's update at zero rows
--       affected).
--   - availability_rules: SELECT (own-tenant visibility) and DELETE (proves
--       RLS, not a missing grant, leaves the client's delete at zero rows
--       affected).
--   - booking_tokens, reminders, calendar_sync_states: SELECT only -- these
--       are server-only tables; SELECT is required so the assertions prove
--       RLS itself (not a missing grant) makes them return zero rows.
--   - calendar_connections: SELECT (same server-only invisibility proof) and
--       INSERT (proves RLS, not a missing grant, rejects the client's
--       server-only insert).
-- Run by scripts/ci/run-rls-check.sh via `psql -v role_name=...`; :"role_name"
-- is a psql identifier variable, never a raw string concatenated into SQL.

grant usage on schema public to :"role_name";
grant select on external_calendars to :"role_name";
grant select on bookings to :"role_name";
grant select on event_attendees to :"role_name";
grant select on calendar_events to :"role_name";
grant select on availability_overrides to :"role_name";
grant select, insert on availability_schedules to :"role_name";
grant select, update on booking_types to :"role_name";
grant select, delete on availability_rules to :"role_name";
grant select on booking_tokens to :"role_name";
grant select on reminders to :"role_name";
grant select on calendar_sync_states to :"role_name";
grant select, insert on calendar_connections to :"role_name";
