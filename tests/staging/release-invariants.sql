-- Read-only, rerunnable staging release assertions. This script intentionally
-- contains no fixtures and no DDL so it is safe to execute after every deploy.

do $$
declare
  expected_migrations text[] := array[
    '20260701000000_initial_baseline',
    '20260712000000_dashboard_indexes',
    '20260712120000_crm_contacts_companies_v1',
    '20260712180000_crm_deals_v1',
    '20260713000000_calendar_booking_v1',
    '20260714000000_secure_document_upload_intents',
    '20260715000000_ai_chat_production_hardening',
    '20260715230000_security_invariant_corrections',
    '20260718000000_calendar_booking_rls',
    '20260719000000_initial_security_baseline'
  ];
  protected_tables text[] := array[
    'users', 'organizations', 'organization_members', 'teams', 'invitations',
    'subscriptions', 'usage_records', 'companies', 'contacts', 'pipelines',
    'pipeline_stages', 'deals', 'activities', 'tags', 'tags_on_contacts',
    'calendar_events', 'event_attendees', 'calendar_connections',
    'external_calendars', 'calendar_sync_states', 'availability_schedules',
    'availability_rules', 'availability_overrides', 'booking_types', 'bookings',
    'booking_tokens', 'reminders', 'conversations', 'conversation_documents',
    'messages', 'collections', 'documents', 'document_chunks',
    'document_upload_intents', 'prompts', 'voice_assistants', 'voice_calls',
    'workflows', 'workflow_runs', 'notifications', 'api_keys',
    'webhook_endpoints', 'audit_logs'
  ];
  missing_name text;
  contract_table text;
  contract_policy text;
  policy_command text;
  policy_roles name[];
  policy_qual text;
  policy_check text;
  crud_tables text[] := array[
    'teams', 'companies', 'contacts', 'pipelines', 'deals', 'activities', 'tags',
    'calendar_events', 'conversations', 'documents', 'collections', 'workflows',
    'voice_assistants', 'webhook_endpoints'
  ];
  direct_read_tables text[] := array[
    'subscriptions', 'usage_records', 'voice_calls', 'workflow_runs',
    'invitations', 'api_keys', 'conversation_documents', 'external_calendars',
    'availability_schedules', 'booking_types', 'bookings'
  ];
begin
  select expected.migration_name
  into missing_name
  from unnest(expected_migrations) as expected(migration_name)
  where not exists (
    select 1
    from public._prisma_migrations as migration
    where migration.migration_name = expected.migration_name
      and migration.finished_at is not null
      and migration.rolled_back_at is null
  )
  limit 1;

  if missing_name is not null then
    raise exception 'STAGING RELEASE FAIL: migration % is not successfully applied', missing_name;
  end if;

  if exists (
    select 1
    from public._prisma_migrations
    where finished_at is null and rolled_back_at is null
  ) then
    raise exception 'STAGING RELEASE FAIL: an unfinished Prisma migration exists';
  end if;

  select table_name
  into missing_name
  from unnest(protected_tables) as expected(table_name)
  where not exists (
    select 1
    from pg_class
    where oid = to_regclass(format('public.%I', table_name))
      and relrowsecurity
  )
  limit 1;

  if missing_name is not null then
    raise exception 'STAGING RELEASE FAIL: RLS is not enabled on public.%', missing_name;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (
        array[
          'calendar_connections', 'calendar_sync_states', 'booking_tokens',
          'reminders', 'document_upload_intents'
        ]
      )
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'STAGING RELEASE FAIL: a server-only table has an authenticated/public policy';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = any (
        array[
          'subscriptions', 'usage_records', 'voice_calls', 'workflow_runs',
          'invitations', 'api_keys', 'conversation_documents', 'messages',
          'document_chunks'
        ]
      )
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and roles && array['authenticated', 'public']::name[]
  ) then
    raise exception 'STAGING RELEASE FAIL: a read-only client table has a write policy';
  end if;

  foreach contract_table in array crud_tables loop
    foreach contract_policy in array array[
      contract_table || '_select', contract_table || '_insert',
      contract_table || '_update', contract_table || '_delete'
    ] loop
      select cmd, roles,
        regexp_replace(replace(lower(coalesce(qual, '')), '::text', ''), '[[:space:]()]', '', 'g'),
        regexp_replace(replace(lower(coalesce(with_check, '')), '::text', ''), '[[:space:]()]', '', 'g')
      into policy_command, policy_roles, policy_qual, policy_check
      from pg_policies
      where schemaname = 'public'
        and tablename = contract_table
        and policyname = contract_policy;

      if policy_roles is distinct from array['authenticated']::name[] then
        raise exception 'STAGING RELEASE FAIL: policy %.% has unexpected roles', contract_table, contract_policy;
      end if;
      if contract_policy = contract_table || '_select'
        and (policy_command <> 'SELECT' or policy_qual <> 'organization_id=auth_org_id' or policy_check <> '') then
        raise exception 'STAGING RELEASE FAIL: policy %.% has an unexpected SELECT predicate', contract_table, contract_policy;
      elsif contract_policy = contract_table || '_insert'
        and (policy_command <> 'INSERT' or policy_qual <> '' or policy_check <> 'organization_id=auth_org_id') then
        raise exception 'STAGING RELEASE FAIL: policy %.% has an unexpected INSERT predicate', contract_table, contract_policy;
      elsif contract_policy = contract_table || '_update'
        and (policy_command <> 'UPDATE' or policy_qual <> 'organization_id=auth_org_id' or policy_check <> '') then
        raise exception 'STAGING RELEASE FAIL: policy %.% has an unexpected UPDATE predicate', contract_table, contract_policy;
      elsif contract_policy = contract_table || '_delete'
        and (
          policy_command <> 'DELETE'
          or policy_qual <> 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']'
          or policy_check <> ''
        ) then
        raise exception 'STAGING RELEASE FAIL: policy %.% has an unexpected DELETE predicate', contract_table, contract_policy;
      end if;
    end loop;
  end loop;

  foreach contract_table in array direct_read_tables loop
    contract_policy := contract_table || '_select';
    select cmd, roles,
      regexp_replace(replace(lower(coalesce(qual, '')), '::text', ''), '[[:space:]()]', '', 'g'),
      regexp_replace(replace(lower(coalesce(with_check, '')), '::text', ''), '[[:space:]()]', '', 'g')
    into policy_command, policy_roles, policy_qual, policy_check
    from pg_policies
    where schemaname = 'public'
      and tablename = contract_table
      and policyname = contract_policy;

    if policy_command is distinct from 'SELECT'
      or policy_roles is distinct from array['authenticated']::name[]
      or policy_qual is distinct from 'organization_id=auth_org_id'
      or policy_check is distinct from '' then
      raise exception 'STAGING RELEASE FAIL: policy %.% has an unexpected read definition', contract_table, contract_policy;
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and roles && array['authenticated']::name[]
      and (
        (cmd in ('SELECT', 'UPDATE', 'DELETE', 'ALL') and lower(coalesce(qual, '')) in ('', 'true', '(true)'))
        or (cmd in ('INSERT', 'UPDATE', 'ALL') and lower(coalesce(with_check, '')) in ('true', '(true)'))
      )
  ) then
    raise exception 'STAGING RELEASE FAIL: an authenticated policy has a missing or universally true predicate';
  end if;

  if to_regprocedure('public.auth_org_id()') is null
    or to_regprocedure('public.auth_role()') is null
    or to_regprocedure('public.match_chunks(uuid,vector,integer,double precision)') is null then
    raise exception 'STAGING RELEASE FAIL: required tenant or embedding function is missing';
  end if;

  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise exception 'STAGING RELEASE FAIL: pgvector extension is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'documents_organization_id_collection_id_fkey'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'conversation_documents_organization_id_conversation_id_fkey'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'conversation_documents_organization_id_document_id_fkey'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'document_chunks_organization_id_document_id_fkey'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'document_upload_intents_tenant_path_check' and convalidated
  ) then
    raise exception 'STAGING RELEASE FAIL: a tenant relationship invariant is missing';
  end if;

  raise notice 'ALL STAGING RELEASE INVARIANTS PASSED';
end $$;
