-- Run against a migrated disposable PostgreSQL test database. Every block must
-- catch a foreign_key_violation/check_violation; success would raise and fail.
BEGIN;

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
