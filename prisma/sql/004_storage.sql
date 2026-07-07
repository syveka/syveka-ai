-- Storage buckets (§6.1). Run via Supabase SQL editor or CLI seed.
insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),
  ('org-logos', 'org-logos', true),
  ('documents', 'documents', false),
  ('voice-recordings', 'voice-recordings', false),
  ('exports', 'exports', false)
on conflict (id) do nothing;

-- Path convention: {bucket}/{org_id}/... — first path segment must match JWT org.
create policy storage_org_read on storage.objects for select to authenticated
  using (
    bucket_id in ('documents','voice-recordings','exports')
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
  );

create policy storage_org_write on storage.objects for insert to authenticated
  with check (
    bucket_id in ('documents','exports')
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
  );

create policy storage_avatar_write on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy storage_public_read on storage.objects for select to public
  using (bucket_id in ('avatars', 'org-logos'));
