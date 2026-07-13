-- CRM Calendar & Booking Assistant V1.
-- Extends calendar_events (timezone, owner, status, CRM links, external sync
-- linkage, soft delete) and adds the booking domain: attendees, availability
-- schedules/rules/overrides, booking types, bookings, secure booking tokens,
-- reminders, and external calendar connection/sync state.
-- Index ownership: this migration owns every index it creates (documented in
-- docs/calendar-booking-v1.md §Migrations).

-- ── Enums ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "EventStatus" AS ENUM ('CONFIRMED', 'TENTATIVE', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AttendeeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'MICROSOFT', 'MOCK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'ERROR', 'DISCONNECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LocationType" AS ENUM ('VIDEO', 'PHONE', 'IN_PERSON', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'RESCHEDULED', 'CANCELED', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BookingTokenPurpose" AS ENUM ('MANAGE', 'CANCEL', 'RESCHEDULE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReminderChannel" AS ENUM ('EMAIL', 'IN_APP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ReminderStatus" AS ENUM ('SCHEDULED', 'SENT', 'FAILED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "EventSource" ADD VALUE IF NOT EXISTS 'BOOKING';

-- ── calendar_events extensions ─────────────────────────────────────────

ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "owner_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'Europe/Helsinki';
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "status" "EventStatus" NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "company_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "external_calendar_id" UUID;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "external_etag" TEXT;
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "canceled_at" TIMESTAMP(3);
ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "calendar_events_organization_id_owner_id_starts_at_idx"
  ON "calendar_events"("organization_id", "owner_id", "starts_at");
CREATE INDEX IF NOT EXISTS "calendar_events_organization_id_contact_id_starts_at_idx"
  ON "calendar_events"("organization_id", "contact_id", "starts_at");
CREATE INDEX IF NOT EXISTS "calendar_events_organization_id_company_id_starts_at_idx"
  ON "calendar_events"("organization_id", "company_id", "starts_at");
CREATE INDEX IF NOT EXISTS "calendar_events_organization_id_deal_id_starts_at_idx"
  ON "calendar_events"("organization_id", "deal_id", "starts_at");
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_events_external_calendar_id_external_id_key"
  ON "calendar_events"("external_calendar_id", "external_id");

-- ── event_attendees ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "event_attendees" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL,
  "contact_id"   UUID,
  "user_id"      UUID,
  "email"        TEXT,
  "name"         TEXT,
  "status"       "AttendeeStatus" NOT NULL DEFAULT 'PENDING',
  "is_organizer" BOOLEAN NOT NULL DEFAULT false,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_attendees_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_attendees_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_attendees_contact_id_fkey" FOREIGN KEY ("contact_id")
    REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "event_attendees_event_id_idx" ON "event_attendees"("event_id");
CREATE INDEX IF NOT EXISTS "event_attendees_contact_id_idx" ON "event_attendees"("contact_id");

-- ── calendar_connections ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "calendar_connections" (
  "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"   UUID NOT NULL,
  "user_id"           UUID NOT NULL,
  "provider"          "CalendarProvider" NOT NULL,
  "account_email"     TEXT,
  "access_token_enc"  TEXT,
  "refresh_token_enc" TEXT,
  "token_expires_at"  TIMESTAMP(3),
  "scopes"            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status"            "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "last_error"        TEXT,
  "last_checked_at"   TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "calendar_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "calendar_connections_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_connections_organization_id_user_id_provider_key"
  ON "calendar_connections"("organization_id", "user_id", "provider");
CREATE INDEX IF NOT EXISTS "calendar_connections_organization_id_idx"
  ON "calendar_connections"("organization_id");

-- ── external_calendars ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "external_calendars" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "connection_id"   UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "external_id"     TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "is_primary"      BOOLEAN NOT NULL DEFAULT false,
  "sync_enabled"    BOOLEAN NOT NULL DEFAULT false,
  "timezone"        TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_calendars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_calendars_connection_id_fkey" FOREIGN KEY ("connection_id")
    REFERENCES "calendar_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "external_calendars_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "external_calendars_connection_id_external_id_key"
  ON "external_calendars"("connection_id", "external_id");
CREATE INDEX IF NOT EXISTS "external_calendars_organization_id_idx"
  ON "external_calendars"("organization_id");

-- calendar_events → external_calendars FK (added after table exists)
DO $$ BEGIN
  ALTER TABLE "calendar_events"
    ADD CONSTRAINT "calendar_events_external_calendar_id_fkey"
    FOREIGN KEY ("external_calendar_id") REFERENCES "external_calendars"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── calendar_sync_states ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "calendar_sync_states" (
  "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"         UUID NOT NULL,
  "external_calendar_id"    UUID NOT NULL,
  "sync_cursor"             TEXT,
  "webhook_subscription_id" TEXT,
  "webhook_resource_id"     TEXT,
  "webhook_expires_at"      TIMESTAMP(3),
  "last_synced_at"          TIMESTAMP(3),
  "last_sync_status"        TEXT,
  "failure_count"           INTEGER NOT NULL DEFAULT 0,
  "updated_at"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "calendar_sync_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "calendar_sync_states_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "calendar_sync_states_external_calendar_id_fkey" FOREIGN KEY ("external_calendar_id")
    REFERENCES "external_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "calendar_sync_states_external_calendar_id_key"
  ON "calendar_sync_states"("external_calendar_id");
CREATE INDEX IF NOT EXISTS "calendar_sync_states_organization_id_idx"
  ON "calendar_sync_states"("organization_id");

-- ── availability_schedules / rules / overrides ─────────────────────────

CREATE TABLE IF NOT EXISTS "availability_schedules" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id"         UUID NOT NULL,
  "name"            TEXT NOT NULL,
  "timezone"        TEXT NOT NULL DEFAULT 'Europe/Helsinki',
  "is_default"      BOOLEAN NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "availability_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "availability_schedules_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "availability_schedules_organization_id_user_id_idx"
  ON "availability_schedules"("organization_id", "user_id");

CREATE TABLE IF NOT EXISTS "availability_rules" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id"  UUID NOT NULL,
  "weekday"      INTEGER NOT NULL,
  "start_minute" INTEGER NOT NULL,
  "end_minute"   INTEGER NOT NULL,
  CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "availability_rules_schedule_id_fkey" FOREIGN KEY ("schedule_id")
    REFERENCES "availability_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "availability_rules_schedule_id_weekday_idx"
  ON "availability_rules"("schedule_id", "weekday");

CREATE TABLE IF NOT EXISTS "availability_overrides" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id"    UUID NOT NULL,
  "date"           DATE NOT NULL,
  "start_minute"   INTEGER,
  "end_minute"     INTEGER,
  "is_unavailable" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "availability_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "availability_overrides_schedule_id_fkey" FOREIGN KEY ("schedule_id")
    REFERENCES "availability_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "availability_overrides_schedule_id_date_idx"
  ON "availability_overrides"("schedule_id", "date");

-- ── booking_types ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "booking_types" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"       UUID NOT NULL,
  "owner_id"              UUID NOT NULL,
  "schedule_id"           UUID,
  "slug"                  TEXT NOT NULL,
  "name"                  TEXT NOT NULL,
  "description"           TEXT,
  "duration_minutes"      INTEGER NOT NULL DEFAULT 30,
  "duration_options"      INTEGER[] NOT NULL DEFAULT ARRAY[30]::INTEGER[],
  "location_type"         "LocationType" NOT NULL DEFAULT 'VIDEO',
  "location"              TEXT,
  "buffer_before_minutes" INTEGER NOT NULL DEFAULT 0,
  "buffer_after_minutes"  INTEGER NOT NULL DEFAULT 0,
  "min_notice_minutes"    INTEGER NOT NULL DEFAULT 120,
  "max_window_days"       INTEGER NOT NULL DEFAULT 60,
  "brand_color"           TEXT,
  "confirmation_message"  TEXT,
  "collect_phone"         BOOLEAN NOT NULL DEFAULT false,
  "collect_company"       BOOLEAN NOT NULL DEFAULT false,
  "requires_consent"      BOOLEAN NOT NULL DEFAULT true,
  "is_active"             BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,
  "deleted_at"            TIMESTAMP(3),
  CONSTRAINT "booking_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_types_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "booking_types_schedule_id_fkey" FOREIGN KEY ("schedule_id")
    REFERENCES "availability_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "booking_types_organization_id_slug_key"
  ON "booking_types"("organization_id", "slug");
CREATE INDEX IF NOT EXISTS "booking_types_organization_id_is_active_idx"
  ON "booking_types"("organization_id", "is_active");

-- ── bookings ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "bookings" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id"     UUID NOT NULL,
  "booking_type_id"     UUID NOT NULL,
  "event_id"            UUID,
  "guest_name"          TEXT NOT NULL,
  "guest_email"         TEXT NOT NULL,
  "guest_phone"         TEXT,
  "guest_company"       TEXT,
  "guest_notes"         TEXT,
  "guest_timezone"      TEXT NOT NULL DEFAULT 'Europe/Helsinki',
  "guest_locale"        "Locale",
  "consent_at"          TIMESTAMP(3),
  "status"              "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
  "starts_at"           TIMESTAMP(3) NOT NULL,
  "ends_at"             TIMESTAMP(3) NOT NULL,
  "canceled_at"         TIMESTAMP(3),
  "cancel_reason"       TEXT,
  "rescheduled_from_id" UUID,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bookings_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bookings_booking_type_id_fkey" FOREIGN KEY ("booking_type_id")
    REFERENCES "booking_types"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "bookings_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "calendar_events"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "bookings_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id")
    REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "bookings_event_id_key" ON "bookings"("event_id");
CREATE INDEX IF NOT EXISTS "bookings_organization_id_starts_at_idx"
  ON "bookings"("organization_id", "starts_at");
CREATE INDEX IF NOT EXISTS "bookings_organization_id_status_starts_at_idx"
  ON "bookings"("organization_id", "status", "starts_at");
CREATE INDEX IF NOT EXISTS "bookings_booking_type_id_starts_at_idx"
  ON "bookings"("booking_type_id", "starts_at");

-- ── booking_tokens ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "booking_tokens" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "booking_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "purpose"    "BookingTokenPurpose" NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at"    TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_tokens_booking_id_fkey" FOREIGN KEY ("booking_id")
    REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "booking_tokens_token_hash_key" ON "booking_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "booking_tokens_booking_id_idx" ON "booking_tokens"("booking_id");

-- ── reminders ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "reminders" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "event_id"        UUID,
  "channel"         "ReminderChannel" NOT NULL DEFAULT 'EMAIL',
  "send_at"         TIMESTAMP(3) NOT NULL,
  "sent_at"         TIMESTAMP(3),
  "status"          "ReminderStatus" NOT NULL DEFAULT 'SCHEDULED',
  "dedupe_key"      TEXT NOT NULL,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reminders_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reminders_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "reminders_dedupe_key_key" ON "reminders"("dedupe_key");
CREATE INDEX IF NOT EXISTS "reminders_organization_id_status_send_at_idx"
  ON "reminders"("organization_id", "status", "send_at");
