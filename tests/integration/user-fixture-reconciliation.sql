-- Run against a migrated disposable PostgreSQL test database.
--
-- Reproduces the exact staging failure: creating a Supabase Auth user
-- (auth.users insert) for an email that already has a public.users row
-- under a *different* id -- which happens whenever an auth.users row is
-- deleted and a new one is created for the same email, since there is no
-- auth.users DELETE trigger that removes or reconciles the corresponding
-- public.users row. Before the fix in 20260902000000_handle_new_user_email_
-- reconciliation, public.handle_new_user()'s `ON CONFLICT (id) DO NOTHING`
-- did not guard against this and the INSERT aborted the whole transaction
-- with "duplicate key value violates unique constraint users_email_key".
--
-- Also proves the fix preserves existing history across the reconciliation:
-- an organization_members row owned by the stale user id must end up
-- pointing at the new id afterward (relying on organization_members_user_id_
-- fkey's ON UPDATE CASCADE), not orphaned or duplicated.
BEGIN;

-- Simulates the pre-existing state: a public.users row was created for this
-- email by a *previous* auth.users identity that has since been deleted.
INSERT INTO users (id, email, full_name, updated_at) VALUES
  ('60000000-0000-4000-8000-000000000001', 'reconcile-fixture@example.test', 'Stale Name', now());

INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
  ('60000000-0000-4000-8000-000000000002', 'Reconciliation Fixture Org', 'reconciliation-fixture-org', now(), now());

INSERT INTO organization_members (id, organization_id, user_id, role) VALUES
  ('60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 'OWNER');

-- The new Supabase Auth identity for the same email, with a fresh id --
-- this is what used to raise users_email_key and abort the transaction.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('60000000-0000-4000-8000-000000000004', 'reconcile-fixture@example.test', '{"full_name": "Fresh Name"}'::jsonb);

DO $$
DECLARE
  reconciled_count integer;
  stale_count integer;
  membership_count integer;
BEGIN
  SELECT count(*) INTO reconciled_count
    FROM users
    WHERE id = '60000000-0000-4000-8000-000000000004'
      AND email = 'reconcile-fixture@example.test'
      AND full_name = 'Fresh Name';
  IF reconciled_count <> 1 THEN
    RAISE EXCEPTION 'expected the stale row to be reconciled onto the new auth id with the new metadata, found % matching rows', reconciled_count;
  END IF;

  SELECT count(*) INTO stale_count FROM users WHERE id = '60000000-0000-4000-8000-000000000001';
  IF stale_count <> 0 THEN
    RAISE EXCEPTION 'expected the stale user id to no longer exist after reconciliation, found %', stale_count;
  END IF;

  SELECT count(*) INTO stale_count FROM users WHERE email = 'reconcile-fixture@example.test';
  IF stale_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one users row for the reconciled email, found %', stale_count;
  END IF;

  SELECT count(*) INTO membership_count
    FROM organization_members
    WHERE organization_id = '60000000-0000-4000-8000-000000000002'
      AND user_id = '60000000-0000-4000-8000-000000000004';
  IF membership_count <> 1 THEN
    RAISE EXCEPTION 'expected the pre-existing organization membership to now reference the new auth id via ON UPDATE CASCADE, found %', membership_count;
  END IF;
END $$;

-- Companion case: a genuinely brand-new user (no pre-existing public.users
-- row for this email at all) must still create a fresh row normally --
-- proving the reconciliation UPDATE added above does not interfere with the
-- common, non-reconciliation path.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('60000000-0000-4000-8000-000000000005', 'brand-new-fixture@example.test', '{"full_name": "Brand New"}'::jsonb);

DO $$
DECLARE
  row_count integer;
BEGIN
  SELECT count(*) INTO row_count
    FROM users
    WHERE id = '60000000-0000-4000-8000-000000000005'
      AND email = 'brand-new-fixture@example.test'
      AND full_name = 'Brand New';
  IF row_count <> 1 THEN
    RAISE EXCEPTION 'expected a brand-new user with no prior row to be inserted normally, found %', row_count;
  END IF;
END $$;

ROLLBACK;
