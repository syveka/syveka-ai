-- RLS for Calendar & Booking V1 tables (run once per environment, after the
-- calendar_booking_v1 migration). Prisma uses the service role and bypasses
-- RLS; these policies protect Supabase-client paths (PostgREST, Realtime).
--
-- Security posture:
--   * calendar_connections, booking_tokens, reminders, calendar_sync_states:
--     RLS enabled with NO authenticated policies → server-only (tokens and
--     encrypted OAuth secrets must never be readable from the client).
--   * availability_*, booking_types, bookings, external_calendars,
--     event_attendees: org-scoped read; writes go through Server Actions.

do $$
declare
  t text;
  new_tables text[] := array[
    'event_attendees','calendar_connections','external_calendars',
    'calendar_sync_states','availability_schedules','availability_rules',
    'availability_overrides','booking_types','bookings','booking_tokens',
    'reminders'
  ];
begin
  foreach t in array new_tables loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Org-scoped SELECT for tables that carry organization_id directly.
do $$
declare
  t text;
  read_tables text[] := array[
    'external_calendars','availability_schedules','booking_types','bookings'
  ];
begin
  foreach t in array read_tables loop
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
      using (organization_id = auth_org_id())$f$, t);
  end loop;
end $$;

-- Parent-scoped SELECT (join through the owning row).
create policy event_attendees_select on event_attendees for select to authenticated
  using (exists (
    select 1 from calendar_events e
    where e.id = event_attendees.event_id and e.organization_id = auth_org_id()
  ));

create policy availability_rules_select on availability_rules for select to authenticated
  using (exists (
    select 1 from availability_schedules s
    where s.id = availability_rules.schedule_id and s.organization_id = auth_org_id()
  ));

create policy availability_overrides_select on availability_overrides for select to authenticated
  using (exists (
    select 1 from availability_schedules s
    where s.id = availability_overrides.schedule_id and s.organization_id = auth_org_id()
  ));

-- calendar_connections / booking_tokens / reminders / calendar_sync_states:
-- intentionally NO policies. RLS enabled + no policy = deny all client access.
