-- Prisma creates public._prisma_migrations itself, outside every migration, so
-- it never got the RLS and ACL hardening the application tables have. On
-- hosted Supabase the `postgres` role's public-schema default privileges then
-- granted anon and authenticated every table privilege on it (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER), and the public schema is
-- what the Data API serves. A read-only production check (2026-10-14) found
-- it is the only public table without RLS.
--
-- Nothing but the migration role reads or writes this table, so it gets RLS
-- with no policies (anon and authenticated see no rows) and loses every grant
-- to those two roles. The migration role owns the table (Prisma created it with
-- that role; ENABLE ROW LEVEL SECURITY below fails for anyone else), and an
-- owner isn't subject to RLS unless it is forced, which it is not. So
-- `prisma migrate deploy`, `migrate status` and the release checks keep working.
--
-- No explicit BEGIN/COMMIT: Prisma already applies each migration in its own
-- transaction (see docs/release-runbook.md). A plain PostgreSQL fixture may not
-- have Supabase's roles, so each revoke runs only when its role exists.

ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;

DO $syveka_prisma_migrations_privileges$
DECLARE
  target_role TEXT;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public._prisma_migrations FROM %I', target_role);
    END IF;
  END LOOP;
END
$syveka_prisma_migrations_privileges$;
