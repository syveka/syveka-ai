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
-- BEGIN COMPLETE RLS POLICY CONTRACT
DO $syveka_complete_policy_contract$
DECLARE
  expected RECORD;
  actual RECORD;
  expected_policy_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('public', 'activities', 'activities_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'activities', 'activities_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'activities', 'activities_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'activities', 'activities_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'api_keys', 'api_keys_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'audit_logs', 'audit_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'']', ''),
      ('public', 'availability_overrides', 'availability_overrides_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1fromavailability_scheduleswhereid=schedule_idandorganization_id=auth_org_id', ''),
      ('public', 'availability_rules', 'availability_rules_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1fromavailability_scheduleswhereid=schedule_idandorganization_id=auth_org_id', ''),
      ('public', 'availability_schedules', 'availability_schedules_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'booking_types', 'booking_types_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'bookings', 'bookings_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'calendar_events', 'calendar_events_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'calendar_events', 'calendar_events_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'calendar_events', 'calendar_events_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'calendar_events', 'calendar_events_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'collections', 'collections_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'collections', 'collections_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'collections', 'collections_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'collections', 'collections_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'companies', 'companies_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'companies', 'companies_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'companies', 'companies_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'companies', 'companies_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'contacts', 'contacts_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'contacts', 'contacts_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'contacts', 'contacts_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'contacts', 'contacts_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'conversation_documents', 'conversation_documents_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'conversation_documents', 'conversation_documents_tenant_isolation', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'conversations', 'conversations_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'conversations', 'conversations_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'conversations', 'conversations_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'conversations', 'conversations_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'deals', 'deals_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'deals', 'deals_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'deals', 'deals_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'deals', 'deals_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'document_chunks', 'chunks_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'documents', 'documents_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'documents', 'documents_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'documents', 'documents_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'documents', 'documents_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'event_attendees', 'event_attendees_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1fromcalendar_eventswhereid=event_idandorganization_id=auth_org_id', ''),
      ('public', 'external_calendars', 'external_calendars_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'invitations', 'invitations_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'messages', 'messages_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1fromconversationswhereid=conversation_idandorganization_id=auth_org_id', ''),
      ('public', 'notifications', 'notifications_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'user_id=uidandorganization_id=auth_org_id', ''),
      ('public', 'notifications', 'notifications_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'user_id=uid', ''),
      ('public', 'organization_members', 'members_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'organizations', 'org_member_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'id=auth_org_id', ''),
      ('public', 'pipeline_stages', 'stages_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1frompipelineswhereid=pipeline_idandorganization_id=auth_org_id', ''),
      ('public', 'pipelines', 'pipelines_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'pipelines', 'pipelines_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'pipelines', 'pipelines_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'pipelines', 'pipelines_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'prompts', 'prompts_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'prompts', 'prompts_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'prompts', 'prompts_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_idisnullororganization_id=auth_org_id', ''),
      ('public', 'prompts', 'prompts_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'subscriptions', 'subscriptions_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'tags_on_contacts', 'contact_tags_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'existsselect1fromcontactswhereid=contact_idandorganization_id=auth_org_id', ''),
      ('public', 'tags', 'tags_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'tags', 'tags_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'tags', 'tags_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'tags', 'tags_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'teams', 'teams_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'teams', 'teams_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'teams', 'teams_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'teams', 'teams_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'usage_records', 'usage_records_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'users', 'users_self_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'id=uid', ''),
      ('public', 'users', 'users_self_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'id=uid', ''),
      ('public', 'voice_assistants', 'voice_assistants_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'voice_assistants', 'voice_assistants_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'voice_assistants', 'voice_assistants_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'voice_assistants', 'voice_assistants_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'voice_calls', 'voice_calls_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'webhook_endpoints', 'webhook_endpoints_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'webhook_endpoints', 'webhook_endpoints_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'webhook_endpoints', 'webhook_endpoints_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'webhook_endpoints', 'webhook_endpoints_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'workflow_runs', 'workflow_runs_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'workflows', 'workflows_delete', 'PERMISSIVE', 'DELETE', '{authenticated}', 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']', ''),
      ('public', 'workflows', 'workflows_insert', 'PERMISSIVE', 'INSERT', '{authenticated}', '', 'organization_id=auth_org_id'),
      ('public', 'workflows', 'workflows_select', 'PERMISSIVE', 'SELECT', '{authenticated}', 'organization_id=auth_org_id', ''),
      ('public', 'workflows', 'workflows_update', 'PERMISSIVE', 'UPDATE', '{authenticated}', 'organization_id=auth_org_id', '')
    ) AS contract(
      schema_name, table_name, policy_name, permissive_mode,
      command_name, policy_roles, normalized_using, normalized_check
    )
  LOOP
    expected_policy_keys := array_append(
      expected_policy_keys,
      expected.schema_name || '.' || expected.table_name || '.' || expected.policy_name
    );

    SELECT
      policy.permissive,
      policy.cmd,
      policy.roles::TEXT[] AS roles,
      regexp_replace(
        regexp_replace(
          regexp_replace(
            replace(lower(coalesce(policy.qual, '')), '::text', ''),
            '(from[[:space:]]+(public[.])?(conversations|pipelines|contacts|calendar_events|availability_schedules))[[:space:]]+(as[[:space:]]+)?[a-z_][a-z0-9_]*',
            'from \3',
            'g'
          ),
          '[a-z_][a-z0-9_]*[.]',
          '',
          'g'
        ),
        '[[:space:]()"]',
        '',
        'g'
      ) AS normalized_using,
      regexp_replace(
        regexp_replace(
          regexp_replace(
            replace(lower(coalesce(policy.with_check, '')), '::text', ''),
            '(from[[:space:]]+(public[.])?(conversations|pipelines|contacts|calendar_events|availability_schedules))[[:space:]]+(as[[:space:]]+)?[a-z_][a-z0-9_]*',
            'from \3',
            'g'
          ),
          '[a-z_][a-z0-9_]*[.]',
          '',
          'g'
        ),
        '[[:space:]()"]',
        '',
        'g'
      ) AS normalized_check
    INTO actual
    FROM pg_policies AS policy
    WHERE policy.schemaname = expected.schema_name
      AND policy.tablename = expected.table_name
      AND policy.policyname = expected.policy_name;

    IF actual.permissive IS DISTINCT FROM expected.permissive_mode
      OR actual.cmd IS DISTINCT FROM expected.command_name
      OR actual.roles IS DISTINCT FROM expected.policy_roles::TEXT[]
      OR actual.normalized_using IS DISTINCT FROM expected.normalized_using
      OR actual.normalized_check IS DISTINCT FROM expected.normalized_check THEN
      RAISE EXCEPTION
        'Syveka RLS contract mismatch %.%.%: expected mode %, command %, roles %, USING %, CHECK %; found mode %, command %, roles %, USING %, CHECK %',
        expected.schema_name, expected.table_name, expected.policy_name,
        expected.permissive_mode, expected.command_name, expected.policy_roles,
        expected.normalized_using, expected.normalized_check,
        actual.permissive, actual.cmd, actual.roles,
        actual.normalized_using, actual.normalized_check;
    END IF;
  END LOOP;

  SELECT
    policy.schemaname AS schema_name,
    policy.tablename AS table_name,
    policy.policyname AS policy_name
  INTO actual
  FROM pg_policies AS policy
  WHERE policy.schemaname = 'public'
    AND policy.roles && ARRAY['authenticated', 'public']::NAME[]
    AND (
      policy.schemaname || '.' || policy.tablename || '.' || policy.policyname
    ) <> ALL(expected_policy_keys)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Syveka RLS contract rejects unexpected authenticated/public policy %.%.%',
      actual.schema_name, actual.table_name, actual.policy_name;
  END IF;
END
$syveka_complete_policy_contract$;
-- END COMPLETE RLS POLICY CONTRACT
