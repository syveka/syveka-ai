-- Supabase Storage compatibility setup. Safe to rerun after Prisma migrations.
-- This remains separate because plain PostgreSQL has no `storage` schema.
begin;

insert into storage.buckets (id, name, public) values
  ('avatars', 'avatars', true),
  ('org-logos', 'org-logos', true),
  ('documents', 'documents', false),
  ('voice-recordings', 'voice-recordings', false),
  ('exports', 'exports', false),
  ('creator-reference-assets', 'creator-reference-assets', false),
  ('creator-generated-media', 'creator-generated-media', false)
on conflict (id) do nothing;

-- Path convention: {bucket}/{org_id}/...; the first path segment must match
-- the authenticated tenant claim.
--
-- Each policy below is CREATEd the first time this file ever runs against a
-- database, and ALTERed (never dropped/recreated) on every later rerun --
-- ALTER POLICY replaces a policy's USING/WITH CHECK expression atomically,
-- in place, with no window where the policy is absent, so RLS coverage is
-- never briefly weakened or gapped by this upgrade. This closes a real gap
-- the original "create if not exists" form had: when a bucket list (e.g.
-- storage_org_read/write's) grows in a later change, "if not exists" is
-- true only the very first time the policy is ever created -- every later
-- run silently no-ops and leaves the live predicate on whatever it was when
-- first created, even though the file's own expected-predicate check further
-- below has since moved on. That is exactly what happened on this project's
-- staging database: storage_org_read/storage_org_write were created before
-- the Creator Studio buckets existed, so the "if not exists" guard silently
-- skipped updating them once those buckets were added here, and the
-- (correctly fail-closed) verification block below then refused to proceed
-- rather than silently leaving stale RLS coverage in place. ALTER POLICY
-- keeps every rerun self-healing instead of requiring a manual repair.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'storage_org_read'
  ) then
    create policy storage_org_read on storage.objects for select to authenticated
      using (
        bucket_id in ('documents','voice-recordings','exports','creator-reference-assets','creator-generated-media')
        and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
      );
  else
    alter policy storage_org_read on storage.objects
      using (
        bucket_id in ('documents','voice-recordings','exports','creator-reference-assets','creator-generated-media')
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
        bucket_id in ('documents','exports','creator-reference-assets','creator-generated-media')
        and (storage.foldername(name))[1] = (auth.jwt() ->> 'org_id')
      );
  else
    alter policy storage_org_write on storage.objects
      with check (
        bucket_id in ('documents','exports','creator-reference-assets','creator-generated-media')
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
  else
    alter policy storage_avatar_write on storage.objects
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
  else
    alter policy storage_public_read on storage.objects
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
      expected_qual := 'bucket_id=anyarray[''documents'',''voice-recordings'',''exports'',''creator-reference-assets'',''creator-generated-media'']andstorage.foldernamename[1]=auth.jwt->>''org_id''';
      expected_check := '';
      if policy_command is distinct from 'SELECT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'Storage policy % has an unexpected command or role', policy_name;
      end if;
    elsif policy_name = 'storage_org_write' then
      expected_qual := '';
      expected_check := 'bucket_id=anyarray[''documents'',''exports'',''creator-reference-assets'',''creator-generated-media'']andstorage.foldernamename[1]=auth.jwt->>''org_id''';
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
