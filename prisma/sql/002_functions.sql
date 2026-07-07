-- RAG retrieval RPC (§15.5) — org-filtered ANN search inside the index scan.
create or replace function match_chunks(
  p_org uuid,
  p_embedding vector(1536),
  p_count int default 8,
  p_threshold float default 0.35
)
returns table (chunk_id uuid, document_id uuid, content text, metadata jsonb, similarity float)
language sql stable as $$
  select id, document_id, content, metadata, 1 - (embedding <=> p_embedding)
  from document_chunks
  where organization_id = p_org
    and embedding is not null
    and 1 - (embedding <=> p_embedding) > p_threshold
  order by embedding <=> p_embedding
  limit p_count;
$$;

-- Mirror auth.users → public.users (§6.3)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, avatar_url, created_at, updated_at)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url',
    now(), now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Custom Access Token Hook (§6.3): injects org_id + role claims.
-- Register in Supabase Dashboard → Authentication → Hooks.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable as $$
declare
  claims jsonb := event -> 'claims';
  v_user uuid := (event ->> 'user_id')::uuid;
  v_org uuid;
  v_role text;
begin
  -- active org from app_metadata, else first membership
  v_org := nullif(event -> 'claims' -> 'app_metadata' ->> 'last_active_org', '')::uuid;

  if v_org is not null then
    select role::text into v_role from organization_members
      where user_id = v_user and organization_id = v_org;
  end if;

  if v_role is null then
    select organization_id, role::text into v_org, v_role
      from organization_members where user_id = v_user
      order by joined_at asc limit 1;
  end if;

  if v_org is not null then
    claims := jsonb_set(claims, '{org_id}', to_jsonb(v_org::text));
    claims := jsonb_set(claims, '{role}', to_jsonb(v_role));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook to supabase_auth_admin;
