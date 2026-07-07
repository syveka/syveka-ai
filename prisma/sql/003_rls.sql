-- Row Level Security for ALL tenant tables (§4.3, §6.2).
-- Prisma uses the service role (bypasses RLS); these policies protect every
-- Supabase-client path: PostgREST, Realtime, Storage.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'organizations','organization_members','teams','invitations','subscriptions',
    'usage_records','companies','contacts','pipelines','deals','activities','tags',
    'calendar_events','conversations','documents','collections','prompts',
    'workflows','workflow_runs','voice_assistants','voice_calls','notifications',
    'api_keys','webhook_endpoints','audit_logs','document_chunks','messages',
    'pipeline_stages','tags_on_contacts','users'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Helper: current org from JWT
create or replace function auth_org_id() returns uuid language sql stable as
  $$ select nullif(auth.jwt() ->> 'org_id', '')::uuid $$;

create or replace function auth_role() returns text language sql stable as
  $$ select auth.jwt() ->> 'role' $$;

-- ── users: self only ──
create policy users_self_select on users for select to authenticated using (id = auth.uid());
create policy users_self_update on users for update to authenticated using (id = auth.uid());

-- ── organizations: member read; server-side writes only ──
create policy org_member_select on organizations for select to authenticated
  using (id = auth_org_id());

-- ── organization_members: visible within org; writes via service role only ──
create policy members_select on organization_members for select to authenticated
  using (organization_id = auth_org_id());

-- ── generic tenant CRUD policies ──
do $$
declare
  t text;
  crud_tables text[] := array[
    'teams','companies','contacts','pipelines','deals','activities','tags',
    'calendar_events','conversations','documents','collections',
    'workflows','voice_assistants','webhook_endpoints'
  ];
begin
  foreach t in array crud_tables loop
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
      using (organization_id = auth_org_id())$f$, t);
    execute format($f$create policy %1$s_insert on %1$I for insert to authenticated
      with check (organization_id = auth_org_id())$f$, t);
    execute format($f$create policy %1$s_update on %1$I for update to authenticated
      using (organization_id = auth_org_id())$f$, t);
    execute format($f$create policy %1$s_delete on %1$I for delete to authenticated
      using (organization_id = auth_org_id()
        and auth_role() in ('OWNER','ADMIN','MANAGER'))$f$, t);
  end loop;
end $$;

-- ── read-only-from-client tables (writes only via service role) ──
do $$
declare
  t text;
  ro_tables text[] := array[
    'subscriptions','usage_records','voice_calls','workflow_runs','invitations','api_keys'
  ];
begin
  foreach t in array ro_tables loop
    execute format($f$create policy %1$s_select on %1$I for select to authenticated
      using (organization_id = auth_org_id())$f$, t);
  end loop;
end $$;

-- ── messages / chunks / stages / contact-tags: scope via parent ──
create policy messages_select on messages for select to authenticated
  using (exists (select 1 from conversations c
    where c.id = conversation_id and c.organization_id = auth_org_id()));

create policy chunks_select on document_chunks for select to authenticated
  using (organization_id = auth_org_id());

create policy stages_select on pipeline_stages for select to authenticated
  using (exists (select 1 from pipelines p
    where p.id = pipeline_id and p.organization_id = auth_org_id()));

create policy contact_tags_select on tags_on_contacts for select to authenticated
  using (exists (select 1 from contacts c
    where c.id = contact_id and c.organization_id = auth_org_id()));

-- ── prompts: org rows + global library (organization_id is null) ──
create policy prompts_select on prompts for select to authenticated
  using (organization_id is null or organization_id = auth_org_id());
create policy prompts_insert on prompts for insert to authenticated
  with check (organization_id = auth_org_id());
create policy prompts_update on prompts for update to authenticated
  using (organization_id = auth_org_id());
create policy prompts_delete on prompts for delete to authenticated
  using (organization_id = auth_org_id() and auth_role() in ('OWNER','ADMIN','MANAGER'));

-- ── notifications: own rows ──
create policy notifications_select on notifications for select to authenticated
  using (user_id = auth.uid() and organization_id = auth_org_id());
create policy notifications_update on notifications for update to authenticated
  using (user_id = auth.uid());

-- ── audit_logs: ADMIN+ read; insert via service role only ──
create policy audit_select on audit_logs for select to authenticated
  using (organization_id = auth_org_id() and auth_role() in ('OWNER','ADMIN'));
