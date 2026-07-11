-- Run once per environment, after the initial Prisma migration.
create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ANN index for RAG retrieval (§5.4)
create index if not exists document_chunks_embedding_idx on document_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

-- Fuzzy CRM search
create index if not exists contacts_name_trgm on contacts
  using gin ((first_name || ' ' || coalesce(last_name, '')) gin_trgm_ops);
create index if not exists companies_name_trgm on companies using gin (name gin_trgm_ops);

-- Dashboard read paths
create index if not exists deals_org_closed_at_idx on deals (organization_id, closed_at);
create index if not exists deals_org_pipeline_closed_at_idx on deals (organization_id, pipeline_id, closed_at);
create index if not exists activities_org_type_due_at_idx on activities (organization_id, type, due_at);
create index if not exists activities_org_type_created_at_idx on activities (organization_id, type, created_at desc);
create index if not exists conversations_org_updated_at_idx on conversations (organization_id, updated_at desc);
