-- SYNTHETIC REHEARSAL ONLY. Run as the local image's superuser, before the
-- migrations. The local supabase/postgres image ships only the oldest Auth
-- objects; hosted Supabase Auth adds auth.jwt() (the migrations need it and
-- may not create it in the auth schema) and the session/token/MFA tables
-- below. These shapes are minimal approximations (the real column sets depend
-- on the Auth version), enough to prove the drill deletes or never carries them.
create or replace function auth.jwt() returns jsonb
language sql stable
as $$ select coalesce(
  nullif(current_setting('request.jwt.claim', true), ''),
  nullif(current_setting('request.jwt.claims', true), '')
)::jsonb $$;
alter function auth.jwt() owner to supabase_auth_admin;
grant execute on function auth.jwt() to postgres, anon, authenticated, service_role;

create table if not exists auth.identities (
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider_id, provider)
);
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz default now()
);
create table if not exists auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  factor_type text not null,
  secret text
);
create table if not exists auth.mfa_challenges (
  id uuid primary key,
  factor_id uuid not null references auth.mfa_factors (id) on delete cascade
);
create table if not exists auth.mfa_amr_claims (
  id uuid primary key,
  session_id uuid not null references auth.sessions (id) on delete cascade,
  authentication_method text not null
);
create table if not exists auth.one_time_tokens (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  token_type text not null,
  token_hash text not null
);
create table if not exists auth.flow_state (
  id uuid primary key,
  user_id uuid,
  auth_code text not null,
  provider_access_token text,
  provider_refresh_token text
);

-- Hosted Storage (storage-api) creates these; the plain image may not have them.
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
grant all on storage.buckets, storage.objects to postgres;

do $owners$
declare
  auth_table text;
begin
  foreach auth_table in array array[
    'identities', 'sessions', 'mfa_factors', 'mfa_challenges', 'mfa_amr_claims',
    'one_time_tokens', 'flow_state'
  ] loop
    execute format('alter table auth.%I owner to supabase_auth_admin', auth_table);
    execute format('grant all on auth.%I to postgres', auth_table);
  end loop;
end
$owners$;
