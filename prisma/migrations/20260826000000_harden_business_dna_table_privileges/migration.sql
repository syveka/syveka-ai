-- The hosted Supabase `postgres` role had table default privileges that granted
-- TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN to `anon` and `authenticated`.
-- RLS does not mediate these capabilities. Remove the inherited grants from the
-- two Business DNA tables and from future tables created by the same migration
-- owner in `public`. DML grants, policies, and service_role privileges are
-- intentionally unchanged.

-- MAINTAIN is a table privilege on the hosted PostgreSQL version but does not
-- exist in the PostgreSQL 15 compatibility target used by repository CI. A
-- plain PostgreSQL fixture may also omit Supabase's `anon` role, so each revoke
-- is issued only when its intended grantee exists. Both roles exist on hosted
-- Supabase and are therefore hardened there.
DO $syveka_table_privileges$
DECLARE
  target_role TEXT;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format(
        'REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.business_dna, public.business_dna_services FROM %I',
        target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM %I',
        target_role
      );

      IF current_setting('server_version_num')::INTEGER >= 170000 THEN
        EXECUTE format(
          'REVOKE MAINTAIN ON TABLE public.business_dna, public.business_dna_services FROM %I',
          target_role
        );
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM %I',
          target_role
        );
      END IF;
    END IF;
  END LOOP;
END
$syveka_table_privileges$;
