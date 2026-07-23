-- Read-only, rerunnable Supabase Storage assertions. Run only after applying
-- prisma/sql/004_storage.sql. Commands, roles, and predicates are all checked;
-- a permissive policy with the expected name is not accepted.

do $$
declare
  policy_name text;
  policy_command text;
  policy_roles name[];
  policy_qual text;
  policy_check text;
  expected_qual text;
  expected_check text;
  documents_public boolean;
begin
  select public into documents_public from storage.buckets where id = 'documents';
  if documents_public is null or documents_public then
    raise exception 'STORAGE FAIL: documents bucket is missing or public';
  end if;

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
        raise exception 'STORAGE FAIL: policy % has an unexpected command or role', policy_name;
      end if;
    elsif policy_name = 'storage_org_write' then
      expected_qual := '';
      expected_check := 'bucket_id=anyarray[''documents'',''exports'']andstorage.foldernamename[1]=auth.jwt->>''org_id''';
      if policy_command is distinct from 'INSERT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'STORAGE FAIL: policy % has an unexpected command or role', policy_name;
      end if;
    elsif policy_name = 'storage_avatar_write' then
      expected_qual := '';
      expected_check := 'bucket_id=''avatars''andstorage.foldernamename[1]=auth.uid';
      if policy_command is distinct from 'INSERT'
        or policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'STORAGE FAIL: policy % has an unexpected command or role', policy_name;
      end if;
    else
      expected_qual := 'bucket_id=anyarray[''avatars'',''org-logos'']';
      expected_check := '';
      if policy_command is distinct from 'SELECT'
        or policy_roles is distinct from array['public']::name[] then
        raise exception 'STORAGE FAIL: policy % has an unexpected command or role', policy_name;
      end if;
    end if;

    if policy_qual is distinct from expected_qual
      or policy_check is distinct from expected_check then
      raise exception 'STORAGE FAIL: policy % has an unexpected predicate', policy_name;
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('UPDATE', 'DELETE', 'ALL')
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'STORAGE FAIL: an unexpected update/delete policy exists';
  end if;

  raise notice 'ALL STAGING STORAGE INVARIANTS PASSED';
end $$;
