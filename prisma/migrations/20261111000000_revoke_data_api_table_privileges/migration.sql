-- Hosted Supabase grants anon and authenticated every privilege on each table
-- the `postgres` role creates in schema public (its default privileges), and
-- the Data API (PostgREST) serves that schema with the public anon key. The
-- application never uses those grants: Prisma connects as the table owner, the
-- server's Supabase calls are storage through the service role, and the
-- browser only subscribes to Realtime changes on `notifications`.
--
-- With the grants in place, RLS is the only control between a signed-in user
-- and the tables, and some policies allow more than the application does. One
-- needs nothing else: `users_self_update` lets a user set their own
-- `public.users.email` to any address. The application reads that column, and
-- `handle_new_user()` moves a `public.users` row whose email matches a new
-- sign-up onto the new account, memberships included.
--
-- So anon and authenticated lose every table and sequence privilege in public,
-- now and for tables created later by the migration role, except SELECT on
-- `notifications` for Realtime (rows still filtered by notifications_select).
-- `custom_access_token_hook` keeps only its supabase_auth_admin grant; it isn't
-- an RPC endpoint. RLS stays enabled everywhere as defense in depth.
--
-- PUBLIC, anon and authenticated also lose EXECUTE on three functions nobody
-- calls over the Data API: handle_new_user() and rls_auto_enable() only fire as
-- triggers, and PostgreSQL checks EXECUTE on a trigger function when the trigger
-- is created, not when it fires; match_chunks() is called through Prisma as the
-- table owner. Owners, postgres, service_role and supabase_auth_admin keep theirs.
--
-- Not affected: the migration role and service_role (neither depends on these
-- grants), the storage and auth schemas, and SECURITY DEFINER triggers.
--
-- No explicit BEGIN/COMMIT: Prisma applies each migration in its own
-- transaction. A plain PostgreSQL fixture may not have Supabase's roles, so each
-- statement runs only when its role exists, and each function revoke only when
-- the function exists (rls_auto_enable() is Supabase's, and not on every project).

DO $syveka_data_api_privileges$
DECLARE
  target_role TEXT;
  target_function TEXT;
  hook_exists BOOLEAN := to_regprocedure('public.custom_access_token_hook(jsonb)') IS NOT NULL;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        target_role
      );
      IF hook_exists THEN
        EXECUTE format(
          'REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM %I',
          target_role
        );
      END IF;
    END IF;
  END LOOP;

  IF hook_exists THEN
    REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
  END IF;

  FOREACH target_function IN ARRAY ARRAY[
    'public.handle_new_user()',
    'public.match_chunks(uuid,vector,integer,double precision)',
    'public.rls_auto_enable()'
  ] LOOP
    IF to_regprocedure(target_function) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', to_regprocedure(target_function));
      FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION %s FROM %I',
            to_regprocedure(target_function),
            target_role
          );
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON TABLE public.notifications TO authenticated;
  END IF;
END
$syveka_data_api_privileges$;
