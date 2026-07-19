-- Supabase Storage compatibility setup. Safe to rerun after Prisma migrations.
-- This remains separate because plain PostgreSQL has no `storage` schema.
begin;

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

do $$
declare
  policy_name text;
  policy_command text;
  policy_roles name[];
  policy_qual text;
  policy_check text;
  expected_qual text;
  expected_check text;
begin
  foreach policy_name in array array[
    'storage_org_read', 'storage_org_write',
    'storage_avatar_write', 'storage_public_read'
  ] loop
    select cmd, roles,
      regexp_replace(replace(lower(coalesce(qual, '')), '::text', ''), '[[:space:]()]', '', 'g'),
      regexp_replace(replace(lower(coalesce(with_check, '')), '::text', ''), '[[:space:]()]', '', 'g')
    into policy_command, policy_roles, policy_qual, policy_check
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = policy_name;

    if policy_name = 'storage_org_read' then
      expected_qual := 'bucket_id=anyarray[''documents'',''voice-recordings'',''exports'']andstorage.foldernamename[1]=auth.jwt->>''org_id''';
      expected_check := '';
      if policy_command is distinct from 'SELECT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'Storage policy % has an unexpected command or role', policy_name;
      end if;
    elsif policy_name = 'storage_org_write' then
      expected_qual := '';
      expected_check := 'bucket_id=anyarray[''documents'',''exports'']andstorage.foldernamename[1]=auth.jwt->>''org_id''';
      if policy_command is distinct from 'INSERT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'Storage policy % has an unexpected command or role', policy_name;
      end if;
    elsif policy_name = 'storage_avatar_write' then
      expected_qual := '';
      expected_check := 'bucket_id=''avatars''andstorage.foldernamename[1]=auth.uid';
      if policy_command is distinct from 'INSERT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'Storage policy % has an unexpected command or role', policy_name;
      end if;
    else
      expected_qual := 'bucket_id=anyarray[''avatars'',''org-logos'']';
      expected_check := '';
      if policy_command is distinct from 'SELECT'
        or policy_roles is distinct from array['public']::name[] then
        raise exception 'Storage policy % has an unexpected command or role', policy_name;
      end if;
    end if;

    if policy_qual is distinct from expected_qual
      or policy_check is distinct from expected_check then
      raise exception 'Storage policy % has an unexpected predicate', policy_name;
    end if;
  end loop;
end $$;

commit;
