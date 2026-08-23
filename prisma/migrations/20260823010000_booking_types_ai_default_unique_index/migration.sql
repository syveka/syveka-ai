-- Database-level invariant for BookingType.isAiBookingDefault: at most one
-- AI-default BookingType per organization. The application-level advisory
-- lock (lockAiDefaultBookingType, src/server/calendar/locks.ts) already
-- serializes the normal saveBookingType path so concurrent claims can't
-- race each other into an inconsistent state - this migration adds the
-- same guarantee at the database layer, so no future code path, script,
-- ad-hoc migration, admin tool, or direct write of any kind can create two
-- AI-default BookingTypes for one organization, even one that bypasses the
-- lock entirely. The two are complementary, not redundant: the advisory
-- lock avoids the race in the first place (so a legitimate concurrent
-- request never gets a spurious constraint-violation error); this index is
-- the backstop that makes the invariant impossible to violate at all.
--
-- Prisma's schema DSL has no syntax for a partial (WHERE-qualified) unique
-- index, so this constraint - like this repository's RLS policies - exists
-- only in raw migration SQL, never in prisma/schema.prisma directly (see
-- the doc comment on BookingType.isAiBookingDefault in schema.prisma,
-- which points here). This does not affect `prisma generate`/`validate`:
-- Prisma only needs the column types it already knows about from the
-- earlier migration that added is_ai_booking_default.
--
-- Safety: a fail-loud pre-check runs FIRST and aborts the entire migration
-- with a specific, actionable error - naming exactly which organization(s)
-- are affected - if any organization already has more than one BookingType
-- row with is_ai_booking_default = true. This is deliberately explicit
-- rather than relying on CREATE UNIQUE INDEX's own generic
-- constraint-violation failure: both fail the migration equally safely
-- (Postgres refuses to create a unique index over data that would violate
-- it - this migration can never silently succeed on inconsistent data),
-- but the explicit check gives whoever runs the migration a clear,
-- actionable message instead of a raw constraint-violation error, and it
-- NEVER deletes, merges, or silently picks a winner among any duplicate
-- rows it finds. If this ever fires, remediation is: manually choose ONE
-- BookingType per affected organization to keep as the AI default (e.g. in
-- the Booking Types settings UI, or a one-off UPDATE targeting a single
-- chosen id per organization_id) and set is_ai_booking_default = false on
-- the others, then re-run this migration. Do not delete any BookingType
-- row to resolve this.
DO $$
DECLARE
  offending_orgs TEXT;
BEGIN
  SELECT string_agg(DISTINCT dupes.organization_id::text, ', ')
  INTO offending_orgs
  FROM (
    SELECT organization_id
    FROM booking_types
    WHERE is_ai_booking_default = true
    GROUP BY organization_id
    HAVING count(*) > 1
  ) AS dupes;

  IF offending_orgs IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add the AI-default BookingType uniqueness index: organization(s) [%] already have more than one BookingType with is_ai_booking_default = true. Manually pick ONE BookingType per affected organization to keep as the AI default (e.g. in the Booking Types settings UI) and set is_ai_booking_default = false on the others - do NOT delete any BookingType row - then re-run this migration.',
      offending_orgs;
  END IF;
END $$;

CREATE UNIQUE INDEX "booking_types_organization_id_is_ai_booking_default_key"
  ON "booking_types" ("organization_id")
  WHERE "is_ai_booking_default" = true;
