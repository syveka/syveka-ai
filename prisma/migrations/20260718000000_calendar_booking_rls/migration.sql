-- Calendar & Booking V1 row-level security.
--
-- This additive migration replaces prisma/sql/005_calendar_booking_rls.sql as
-- the source of truth. Every operation is compatible with environments where
-- that standalone SQL was applied previously: RLS enabling is idempotent and
-- policies are created only when the same table/policy name is absent.
-- Existing policies are never dropped or altered.

-- These tables contain encrypted credentials, tokens, synchronization state,
-- or reminder delivery state. They intentionally have no authenticated/public
-- policies. Abort before making changes instead of deleting an unexpected
-- policy: deployment must never silently rewrite an environment's security.
DO $$
DECLARE
  unexpected_policy RECORD;
BEGIN
  SELECT tablename, policyname
  INTO unexpected_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY (
      ARRAY[
        'calendar_connections',
        'booking_tokens',
        'reminders',
        'calendar_sync_states'
      ]
    )
    AND roles && ARRAY['authenticated', 'public']::name[]
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Calendar/Booking RLS migration refused authenticated policy %.% on a server-only table',
      unexpected_policy.tablename,
      unexpected_policy.policyname;
  END IF;
END $$;

DO $$
DECLARE
  table_name TEXT;
  protected_tables TEXT[] := ARRAY[
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
  ];
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

-- Organization-scoped reads for tables carrying organization_id directly.
DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
  readable_tables TEXT[] := ARRAY[
    'external_calendars',
    'availability_schedules',
    'booking_types',
    'bookings'
  ];
BEGIN
  FOREACH table_name IN ARRAY readable_tables LOOP
    policy_name := table_name || '_select';

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = auth_org_id())',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

-- Parent-scoped reads. These retain the policy names and predicates used by
-- the former standalone SQL so already-provisioned environments are no-ops.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'event_attendees'
      AND policyname = 'event_attendees_select'
  ) THEN
    CREATE POLICY event_attendees_select ON public.event_attendees
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.calendar_events AS event
          WHERE event.id = event_attendees.event_id
            AND event.organization_id = auth_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'availability_rules'
      AND policyname = 'availability_rules_select'
  ) THEN
    CREATE POLICY availability_rules_select ON public.availability_rules
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.availability_schedules AS schedule
          WHERE schedule.id = availability_rules.schedule_id
            AND schedule.organization_id = auth_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'availability_overrides'
      AND policyname = 'availability_overrides_select'
  ) THEN
    CREATE POLICY availability_overrides_select ON public.availability_overrides
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.availability_schedules AS schedule
          WHERE schedule.id = availability_overrides.schedule_id
            AND schedule.organization_id = auth_org_id()
        )
      );
  END IF;
END $$;
