-- Supabase Storage compatibility setup. Safe to rerun after Prisma migrations.
-- This remains separate because plain PostgreSQL has no `storage` schema.
insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),
  ('org-logos', 'org-logos', true),
  ('documents', 'documents', false),
  ('voice-recordings', 'voice-recordings', false),
  ('exports', 'exports', false)
on conflict (id) do nothing;

-- Path convention: {bucket}/{org_id}/...; the first path segment must match
-- the authenticated tenant claim.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_org_read'
  ) then
    create policy storage_org_read on storage.objects for select to authenticated
      using (
        bucket_id in ('documents','voice-recordings','exports')
        and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_org_write'
  ) then
    create policy storage_org_write on storage.objects for insert to authenticated
      with check (
        bucket_id in ('documents','exports')
        and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_avatar_write'
  ) then
    create policy storage_avatar_write on storage.objects for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_public_read'
  ) then
    create policy storage_public_read on storage.objects for select to public
      using (bucket_id in ('avatars', 'org-logos'));
  end if;
end $$;
