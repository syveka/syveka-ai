-- Minimal local-only Supabase compatibility objects for migration CI.
-- This does not model Supabase services; it only supplies objects referenced
-- by the published schema and RLS SQL.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid()
returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.jwt()
returns jsonb language sql stable as $$ select '{}'::jsonb $$;

grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant execute on function auth.jwt() to authenticated;
