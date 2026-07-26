-- Run against a migrated disposable PostgreSQL test database. Every block must
-- catch a foreign_key_violation/check_violation; success would raise and fail.
BEGIN;

-- This file proves the composite FK/CHECK constraints reject cross-tenant data --
-- it is not an RLS test (see tests/rls/*.sql for that). conversation_documents has
-- FORCE ROW LEVEL SECURITY (20260715000000_ai_chat_production_hardening), which
-- applies RLS even to the table's owner. Under a non-superuser, non-BYPASSRLS
-- execution role (e.g. Supabase's direct database role) the plain insert below
-- would be blocked by RLS before the FK constraint this file is actually checking
-- ever gets a chance to fire, and RLS's "insufficient_privilege" is not one of the
-- exceptions the blocks below catch -- nor should it become one; that would let a
-- real FK regression slip through disguised as an RLS rejection.
--
-- Fail loudly, before changing anything, unless this session both owns the table
-- and finds it in exactly the expected already-enabled-and-forced state -- toggling
-- FORCE off is only meaningful, and only safe to reason about, from that starting
-- point. ALTER TABLE is transactional DDL, so ROLLBACK at the end of this file
-- restores FORCE ROW LEVEL SECURITY automatically; nothing else needs to undo it.
DO $$
DECLARE
  is_owner boolean;
  rls_enabled boolean;
  rls_forced boolean;
BEGIN
  SELECT pg_has_role(current_user, relowner, 'MEMBER'), relrowsecurity, relforcerowsecurity
    INTO is_owner, rls_enabled, rls_forced
    FROM pg_class
    WHERE oid = 'public.conversation_documents'::regclass;

  IF NOT is_owner THEN
    RAISE EXCEPTION 'tenant-relationship-integrity.sql requires % to own (or have the '
      'privileges of the owner of) public.conversation_documents to safely toggle '
      'FORCE ROW LEVEL SECURITY for this transaction only', current_user;
  END IF;
  IF NOT rls_enabled OR NOT rls_forced THEN
    RAISE EXCEPTION 'tenant-relationship-integrity.sql expected public.conversation_documents '
      'to already have row security enabled and forced (enabled=%, forced=%); refusing to '
      'proceed from an unexpected starting state', rls_enabled, rls_forced;
  END IF;
END $$;

ALTER TABLE conversation_documents NO FORCE ROW LEVEL SECURITY;

INSERT INTO users (id, email, updated_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'tenant-a@example.test', now()),
  ('10000000-0000-4000-8000-000000000002', 'tenant-b@example.test', now());
INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Tenant A', 'tenant-integrity-a', now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'Tenant B', 'tenant-integrity-b', now(), now());
INSERT INTO collections (id, organization_id, name) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'A'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'B');
INSERT INTO conversations (id, organization_id, user_id, updated_at) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', now()),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', now());
INSERT INTO documents (id, organization_id, uploaded_by_id, title, source_type, updated_at) VALUES
  ('50000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A', 'NOTE', now()),
  ('50000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'B', 'NOTE', now());

DO $$ BEGIN
  UPDATE documents
    SET collection_id = '30000000-0000-4000-8000-000000000002'
    WHERE id = '50000000-0000-4000-8000-000000000001';
  RAISE EXCEPTION 'cross-tenant collection update unexpectedly succeeded';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO conversation_documents (organization_id, conversation_id, document_id)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001'
  );
  RAISE EXCEPTION 'cross-tenant conversation insert unexpectedly succeeded';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO conversation_documents (organization_id, conversation_id, document_id)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002'
  );
  RAISE EXCEPTION 'cross-tenant document insert unexpectedly succeeded';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO document_chunks (document_id, organization_id, chunk_index, content, token_count)
  VALUES (
    '50000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    0, 'cross tenant', 2
  );
  RAISE EXCEPTION 'cross-tenant chunk insert unexpectedly succeeded';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO document_upload_intents (
    organization_id, user_id, storage_path, expected_mime_type, max_size_bytes, expires_at
  ) VALUES (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002/file.pdf',
    'application/pdf', 100, now() + interval '10 minutes'
  );
  RAISE EXCEPTION 'cross-tenant upload path unexpectedly succeeded';
EXCEPTION WHEN check_violation THEN NULL; END $$;

ROLLBACK;
