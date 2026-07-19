-- Rerunnable Supabase Storage assertions. Run only on Supabase after applying
-- prisma/sql/004_storage.sql.

do $$
declare
  documents_public boolean;
begin
  select public
  into documents_public
  from storage.buckets
  where id = 'documents';

  if documents_public is null or documents_public then
    raise exception 'STORAGE FAIL: documents bucket is missing or public';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'storage_org_read'
      and cmd = 'SELECT'
      and roles @> array['authenticated']::name[]
      and qual like '%foldername%'
      and qual like '%org_id%'
  ) then
    raise exception 'STORAGE FAIL: tenant-scoped authenticated read policy is missing';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'storage_org_write'
      and cmd = 'INSERT'
      and roles @> array['authenticated']::name[]
      and with_check like '%foldername%'
      and with_check like '%org_id%'
  ) then
    raise exception 'STORAGE FAIL: tenant-scoped authenticated insert policy is missing';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and roles && array['public']::name[]
      and (
        policyname <> 'storage_public_read'
        or coalesce(qual, '') like '%documents%'
      )
  ) then
    raise exception 'STORAGE FAIL: documents bucket is exposed by a public policy';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd in ('UPDATE', 'DELETE', 'ALL')
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'STORAGE FAIL: documents bucket has an unexpected update/delete policy';
  end if;

  raise notice 'ALL STAGING STORAGE INVARIANTS PASSED';
end $$;
