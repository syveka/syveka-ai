-- Minimal local-only Supabase compatibility objects for migration CI.
-- This does not model Supabase services; it only supplies objects referenced
-- by the published schema and RLS SQL.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end $$;

-- Reproduce the hosted default ACL that caused this regression. The probe proves
-- the unsafe pre-migration state exists; the forward migration and its dedicated
-- regression test prove both existing-table and future-table grants are removed.
alter default privileges for role current_user in schema public
grant truncate, references, trigger on tables to anon, authenticated;

do $$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'alter default privileges for role current_user in schema public grant maintain on tables to anon, authenticated';
  end if;
end $$;

create table public.business_dna_unsafe_default_probe (id integer primary key);

do $$
declare
  checked_role text;
  checked_privilege text;
  checked_privileges text[] := array['TRUNCATE', 'REFERENCES', 'TRIGGER'];
begin
  if current_setting('server_version_num')::integer >= 170000 then
    checked_privileges := array_append(checked_privileges, 'MAINTAIN');
  end if;

  foreach checked_role in array array['anon', 'authenticated'] loop
    foreach checked_privilege in array checked_privileges loop
      if not has_table_privilege(
        checked_role,
        'public.business_dna_unsafe_default_probe',
        checked_privilege
      ) then
        raise exception
          'SUPABASE COMPATIBILITY FIXTURE FAIL: role % should begin with % on the unsafe default probe',
          checked_role, checked_privilege;
      end if;
    end loop;
  end loop;
end $$;

drop table public.business_dna_unsafe_default_probe;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function auth.jwt() to authenticated;
