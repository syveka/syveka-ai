-- Deprecated compatibility entrypoint for operators following older setup
-- documentation. Calendar & Booking RLS is owned by the tracked Prisma
-- migration below. New deployments must use `prisma migrate deploy`.
--
-- `\ir` resolves relative to this file, so this wrapper contains no duplicate
-- policy definitions and remains safe when the migration was applied already.
\ir ../migrations/20260718000000_calendar_booking_rls/migration.sql
