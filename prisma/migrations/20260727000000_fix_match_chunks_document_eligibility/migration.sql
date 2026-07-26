-- The general-search retrieval path (match_chunks()) filtered only by organization_id,
-- unlike the documentId-scoped path in src/server/ai/rag.ts, which also requires
-- d.deleted_at IS NULL AND d.status = 'READY'. Because deleteDocument() soft-deletes and
-- deletes chunks as two separate, non-transactional calls, a crash between them (or a
-- document still mid-embedding, before status flips to READY) could leave its chunks
-- retrievable via general KB search. This is a same-tenant data-consistency gap, not a
-- cross-tenant leak (docs/AI-RAG-AUDIT.md §6).
--
-- Fix: join document_chunks to documents and require the same eligibility the
-- documentId-scoped path already enforces, applying similarity ordering and p_count only
-- after that filter — so a match_chunks(..., 8, ...) call still returns up to 8 eligible
-- rows rather than up to 8 rows pre-filter that could shrink after an application-layer
-- filter. Signature and returned columns are unchanged, so
-- to_regprocedure('public.match_chunks(uuid,vector,integer,double precision)')
-- (tests/staging/release-invariants.sql) still resolves.

CREATE OR REPLACE FUNCTION public.match_chunks(
  p_org UUID,
  p_embedding vector(1536),
  p_count INTEGER DEFAULT 8,
  p_threshold DOUBLE PRECISION DEFAULT 0.35
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  content TEXT,
  metadata JSONB,
  similarity DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  SELECT dc.id, dc.document_id, dc.content, dc.metadata, 1 - (dc.embedding <=> p_embedding)
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.organization_id = p_org
    AND dc.embedding IS NOT NULL
    AND d.deleted_at IS NULL
    AND d.status = 'READY'
    AND 1 - (dc.embedding <=> p_embedding) > p_threshold
  ORDER BY dc.embedding <=> p_embedding
  LIMIT p_count
$$;
