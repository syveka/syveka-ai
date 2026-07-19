-- Minimal local-only shape of Supabase Storage used to test compatibility SQL.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(path text)
returns text[] language sql immutable as $$
  select string_to_array(path, '/')[1:greatest(array_length(string_to_array(path, '/'), 1) - 1, 0)]
$$;
