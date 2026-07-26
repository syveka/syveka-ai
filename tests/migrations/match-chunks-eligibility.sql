-- Verifies match_chunks() enforces document eligibility (deleted_at IS NULL, status =
-- 'READY') directly inside the SQL function, matching the documentId-scoped path in
-- src/server/ai/rag.ts, without weakening organization isolation, similarity ordering,
-- or the count/threshold contract. Runs against a fully migrated DB (fresh install
-- path). Wrapped in a transaction and rolled back, so it never leaves fixture data
-- behind and is safe to rerun.

begin;

-- Session-local helper: builds a 1536-dim vector with only the first two components
-- set, so cosine similarity against the query vector (1,0,...) is fully controlled by
-- v1/v2 without needing real embeddings.
create or replace function pg_temp.vec2(v1 double precision, v2 double precision)
returns vector(1536) language sql as $$
  select ('[' || v1 || ',' || v2 || ',' || repeat('0,', 1533) || '0]')::vector(1536)
$$;

do $$
declare
  org_a uuid := '33330000-0000-4000-8000-000000000001';
  org_b uuid := '33330000-0000-4000-8000-000000000002';
  test_user uuid := '33330000-0000-4000-8000-000000000003';
  doc_ready uuid := '33330000-0000-4000-8000-000000000011';
  doc_deleted uuid := '33330000-0000-4000-8000-000000000012';
  doc_pending uuid := '33330000-0000-4000-8000-000000000013';
  doc_other_org uuid := '33330000-0000-4000-8000-000000000014';
  query_vec vector(1536) := pg_temp.vec2(1, 0);
  n int;
  contents text[];
begin
  delete from document_chunks
    where document_id in (doc_ready, doc_deleted, doc_pending, doc_other_org);
  delete from documents
    where id in (doc_ready, doc_deleted, doc_pending, doc_other_org);
  delete from organizations where id in (org_a, org_b);
  delete from users where id = test_user;

  insert into organizations (id, name, slug, updated_at) values
    (org_a, 'Match Chunks Org A', 'match-chunks-org-a-test', now()),
    (org_b, 'Match Chunks Org B', 'match-chunks-org-b-test', now());
  insert into users (id, email, updated_at) values (test_user, 'match-chunks-test@example.com', now());

  insert into documents (id, organization_id, uploaded_by_id, title, source_type, status, deleted_at, updated_at) values
    (doc_ready,     org_a, test_user, 'Ready doc',        'NOTE', 'READY',   null,  now()),
    (doc_deleted,   org_a, test_user, 'Soft-deleted doc', 'NOTE', 'READY',   now(), now()),
    (doc_pending,   org_a, test_user, 'Pending doc',      'NOTE', 'PENDING', null,  now()),
    (doc_other_org, org_b, test_user, 'Other org doc',    'NOTE', 'READY',   null,  now());

  -- Similarities against query_vec = (1,0,...): ready≈1.0, deleted≈0.95 (ranks between
  -- the two eligible chunks below), pending≈1.0, other_org≈1.0.
  -- A second, lower-similarity (~0.9) eligible chunk on doc_ready is what requirement 5
  -- (count applies post-eligibility-filter) depends on.
  insert into document_chunks (id, document_id, organization_id, chunk_index, content, token_count, embedding) values
    (gen_random_uuid(), doc_ready,     org_a, 0, 'ready chunk sim-1.0',      10, pg_temp.vec2(1, 0)),
    (gen_random_uuid(), doc_ready,     org_a, 1, 'ready chunk sim-0.9',      10, pg_temp.vec2(0.9, 0.4358898943540674)),
    (gen_random_uuid(), doc_deleted,   org_a, 0, 'deleted-doc chunk sim-0.95', 10, pg_temp.vec2(0.95, 0.31224989991991995)),
    (gen_random_uuid(), doc_pending,   org_a, 0, 'pending-doc chunk sim-1.0', 10, pg_temp.vec2(1, 0)),
    (gen_random_uuid(), doc_other_org, org_b, 0, 'other-org chunk sim-1.0', 10, pg_temp.vec2(1, 0));

  -- 1. READY, non-deleted chunks are returned.
  select count(*) into n from match_chunks(org_a, query_vec, 8, 0.0) where content = 'ready chunk sim-1.0';
  if n <> 1 then
    raise exception 'MATCH_CHUNKS FAIL: expected the ready/non-deleted chunk to be returned, got %', n;
  end if;

  -- 2. Soft-deleted documents are excluded.
  select count(*) into n from match_chunks(org_a, query_vec, 8, 0.0) where content like 'deleted-doc%';
  if n <> 0 then
    raise exception 'MATCH_CHUNKS FAIL: soft-deleted document chunk was returned';
  end if;

  -- 3. Non-READY documents are excluded.
  select count(*) into n from match_chunks(org_a, query_vec, 8, 0.0) where content like 'pending-doc%';
  if n <> 0 then
    raise exception 'MATCH_CHUNKS FAIL: non-READY document chunk was returned';
  end if;

  -- 4. Organization isolation remains enforced.
  select count(*) into n from match_chunks(org_a, query_vec, 8, 0.0) where content like 'other-org%';
  if n <> 0 then
    raise exception 'MATCH_CHUNKS FAIL: cross-organization chunk was returned for org_a';
  end if;
  select count(*) into n from match_chunks(org_b, query_vec, 8, 0.0) where content like 'other-org%';
  if n <> 1 then
    raise exception 'MATCH_CHUNKS FAIL: org_b could not retrieve its own eligible chunk';
  end if;

  -- 5. p_count applies to eligible rows only. The ineligible (soft-deleted) chunk sits
  -- at similarity ~0.95, ranking between the two genuinely-eligible chunks (~1.0 and
  -- ~0.9). A limit applied before the eligibility filter would return the ~1.0 chunk
  -- plus the ineligible ~0.95 one, silently dropping the eligible ~0.9 chunk. With
  -- eligibility applied first, requesting 2 rows must return exactly the two eligible
  -- ones.
  select array_agg(content order by similarity desc) into contents
    from match_chunks(org_a, query_vec, 2, 0.0);
  if contents is null or array_length(contents, 1) <> 2
     or not ('ready chunk sim-1.0' = any(contents))
     or not ('ready chunk sim-0.9' = any(contents))
  then
    raise exception 'MATCH_CHUNKS FAIL: count-after-eligibility-filter contract violated, got %', contents;
  end if;

  raise notice 'ALL MATCH_CHUNKS ELIGIBILITY ASSERTIONS PASSED';
end $$;

rollback;
