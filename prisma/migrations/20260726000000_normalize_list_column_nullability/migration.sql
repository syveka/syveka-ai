-- Backfills any NULL values left by real legacy databases that were originally provisioned
-- via `prisma db push` against a pre-migration-system schema (Prisma's db push does not emit
-- NOT NULL for scalar-list columns even when the Prisma field is required), then enforces the
-- NOT NULL constraint that prisma/migrations/20260713000000_calendar_booking_v1 already
-- applies on a fresh install.
--
-- A legacy database upgrading via `prisma migrate deploy` has that earlier migration marked
-- as already-applied (see scripts/ci/provision-legacy-database.sh) and so never actually runs
-- its DDL, which means its NOT NULL constraint never takes effect on that path. This migration
-- is what makes NOT NULL real for legacy upgrades too.
--
-- Naturally idempotent: re-running finds no remaining NULLs to update, and PostgreSQL allows
-- SET NOT NULL on an already-NOT-NULL column as a no-op.

UPDATE "booking_types" SET "duration_options" = ARRAY[30]::INTEGER[] WHERE "duration_options" IS NULL;
ALTER TABLE "booking_types" ALTER COLUMN "duration_options" SET NOT NULL;

UPDATE "calendar_connections" SET "scopes" = ARRAY[]::TEXT[] WHERE "scopes" IS NULL;
ALTER TABLE "calendar_connections" ALTER COLUMN "scopes" SET NOT NULL;
