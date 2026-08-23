-- Unified booking lifecycle (Task 2): explicit pilot-default BookingType for
-- AI/voice bookings, plus outbound Google Calendar push status tracking on
-- CalendarEvent. Both are additive (new nullable/defaulted columns, new
-- enum) — no backfill needed, no existing row's meaning changes.

-- BookingType.isAiBookingDefault: which BookingType the voice AI tool books
-- into. "At most one per org" is enforced in application code
-- (saveBookingType), mirroring AvailabilitySchedule.isDefault's existing
-- pattern rather than a DB constraint — see src/server/services/booking.ts.
ALTER TABLE "booking_types"
  ADD COLUMN "is_ai_booking_default" BOOLEAN NOT NULL DEFAULT false;

-- CalendarEvent outbound Google push status. AMBIGUOUS is a real, reachable
-- value (a network-level failure with no response received) — nothing
-- auto-retries FAILED or AMBIGUOUS, to avoid risking a duplicate event on
-- Google. See src/server/services/calendar-sync.ts's
-- pushBookingEventToGoogle()/cancelBookingEventOnGoogle().
CREATE TYPE "GoogleSyncStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SYNCED', 'FAILED', 'AMBIGUOUS');

ALTER TABLE "calendar_events"
  ADD COLUMN "google_sync_status" "GoogleSyncStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "google_sync_error" TEXT;
