-- Objects from published migrations that Prisma db push cannot represent.
-- Used only after restoring the schema at the verified legacy commit.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_upload_intents'::regclass
      and conname = 'document_upload_intents_tenant_path_check'
  ) then
    alter table public.document_upload_intents
      add constraint document_upload_intents_tenant_path_check
      check (storage_path like organization_id::text || '/%') not valid;
  end if;
end $$;

alter table public.document_upload_intents
  validate constraint document_upload_intents_tenant_path_check;
alter table public.conversation_documents enable row level security;
alter table public.conversation_documents force row level security;
