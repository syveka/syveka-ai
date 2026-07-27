-- Exact inverse of tests/rls/calendar-booking-grants.sql, run during cleanup
-- before the role itself is dropped.

revoke select, insert on calendar_connections from :"role_name";
revoke select on calendar_sync_states from :"role_name";
revoke select on reminders from :"role_name";
revoke select on booking_tokens from :"role_name";
revoke select, delete on availability_rules from :"role_name";
revoke select, update on booking_types from :"role_name";
revoke select, insert on availability_schedules from :"role_name";
revoke select on availability_overrides from :"role_name";
revoke select on calendar_events from :"role_name";
revoke select on event_attendees from :"role_name";
revoke select on bookings from :"role_name";
revoke select on external_calendars from :"role_name";
revoke usage on schema public from :"role_name";
