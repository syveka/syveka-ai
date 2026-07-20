BEGIN;

-- Track the original manually provisioned database functions, indexes, and
-- row-level-security rules. Every operation is additive/idempotent so this
-- migration is safe for both clean databases and previously provisioned
-- Supabase projects. Existing policies are never dropped or rewritten.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON public.document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS contacts_name_trgm
  ON public.contacts
  USING gin ((first_name || ' ' || coalesce(last_name, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS companies_name_trgm
  ON public.companies
  USING gin (name gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.match_chunks(
  p_org UUID,
  p_embedding vector(1536),
  p_count INTEGER DEFAULT 8,
  p_threshold DOUBLE PRECISION DEFAULT 0.35
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  content TEXT,
  metadata JSONB,
  similarity DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  SELECT id, document_id, content, metadata, 1 - (embedding <=> p_embedding)
  FROM public.document_chunks
  WHERE organization_id = p_org
    AND embedding IS NOT NULL
    AND 1 - (embedding <=> p_embedding) > p_threshold
  ORDER BY embedding <=> p_embedding
  LIMIT p_count
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id, email, full_name, avatar_url, created_at, updated_at
  ) VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'avatar_url',
    now(),
    now()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims JSONB := event -> 'claims';
  v_user UUID := (event ->> 'user_id')::UUID;
  v_org UUID;
  v_role TEXT;
BEGIN
  v_org := nullif(
    event -> 'claims' -> 'app_metadata' ->> 'last_active_org',
    ''
  )::UUID;

  IF v_org IS NOT NULL THEN
    SELECT role::TEXT
    INTO v_role
    FROM public.organization_members
    WHERE user_id = v_user AND organization_id = v_org;
  END IF;

  IF v_role IS NULL THEN
    SELECT organization_id, role::TEXT
    INTO v_org, v_role
    FROM public.organization_members
    WHERE user_id = v_user
    ORDER BY joined_at ASC
    LIMIT 1;
  END IF;

  IF v_org IS NOT NULL THEN
    claims := jsonb_set(claims, '{org_id}', to_jsonb(v_org::TEXT));
    claims := jsonb_set(claims, '{role}', to_jsonb(v_role));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB)
  TO supabase_auth_admin;

DO $$
DECLARE
  table_name TEXT;
  protected_tables TEXT[] := ARRAY[
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
BEGIN
  FOREACH table_name IN ARRAY protected_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

-- A pre-existing policy with the expected name is compatibility-safe only
-- when its command, role, and tenant predicate are also the expected ones.
-- Refuse drift instead of silently replacing a published security boundary.
CREATE OR REPLACE FUNCTION pg_temp.assert_syveka_policy_contract()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
  policy_command TEXT;
  policy_roles NAME[];
  policy_qual TEXT;
  policy_check TEXT;
  crud_tables TEXT[] := ARRAY[
    'teams', 'companies', 'contacts', 'pipelines', 'deals', 'activities', 'tags',
    'calendar_events', 'conversations', 'documents', 'collections', 'workflows',
    'voice_assistants', 'webhook_endpoints'
  ];
  read_only_tables TEXT[] := ARRAY[
    'subscriptions', 'usage_records', 'voice_calls', 'workflow_runs',
    'invitations', 'api_keys', 'conversation_documents'
  ];
BEGIN
  FOREACH table_name IN ARRAY crud_tables LOOP
    FOREACH policy_name IN ARRAY ARRAY[
      table_name || '_select', table_name || '_insert',
      table_name || '_update', table_name || '_delete'
    ] LOOP
      SELECT cmd, roles,
        regexp_replace(replace(lower(coalesce(qual, '')), '::text', ''), '[[:space:]()]', '', 'g'),
        regexp_replace(replace(lower(coalesce(with_check, '')), '::text', ''), '[[:space:]()]', '', 'g')
      INTO policy_command, policy_roles, policy_qual, policy_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = table_name AND policyname = policy_name;

      IF policy_roles IS DISTINCT FROM ARRAY['authenticated']::NAME[] THEN
        RAISE EXCEPTION 'Security baseline policy %.% has unexpected roles', table_name, policy_name;
      END IF;

      IF policy_name = table_name || '_select'
        AND (policy_command <> 'SELECT' OR policy_qual <> 'organization_id=auth_org_id' OR policy_check <> '') THEN
        RAISE EXCEPTION 'Security baseline policy %.% has an unexpected SELECT definition', table_name, policy_name;
      ELSIF policy_name = table_name || '_insert'
        AND (policy_command <> 'INSERT' OR policy_qual <> '' OR policy_check <> 'organization_id=auth_org_id') THEN
        RAISE EXCEPTION 'Security baseline policy %.% has an unexpected INSERT definition', table_name, policy_name;
      ELSIF policy_name = table_name || '_update'
        AND (policy_command <> 'UPDATE' OR policy_qual <> 'organization_id=auth_org_id' OR policy_check <> '') THEN
        RAISE EXCEPTION 'Security baseline policy %.% has an unexpected UPDATE definition', table_name, policy_name;
      ELSIF policy_name = table_name || '_delete'
        AND (
          policy_command <> 'DELETE'
          OR policy_qual <> 'organization_id=auth_org_idandauth_role=anyarray[''owner'',''admin'',''manager'']'
          OR policy_check <> ''
        ) THEN
        RAISE EXCEPTION 'Security baseline policy %.% has an unexpected DELETE definition', table_name, policy_name;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH table_name IN ARRAY read_only_tables LOOP
    policy_name := table_name || '_select';
    SELECT cmd, roles,
      regexp_replace(replace(lower(coalesce(qual, '')), '::text', ''), '[[:space:]()]', '', 'g'),
      regexp_replace(replace(lower(coalesce(with_check, '')), '::text', ''), '[[:space:]()]', '', 'g')
    INTO policy_command, policy_roles, policy_qual, policy_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = table_name AND policyname = policy_name;

    IF policy_command IS DISTINCT FROM 'SELECT'
      OR policy_roles IS DISTINCT FROM ARRAY['authenticated']::NAME[]
      OR policy_qual IS DISTINCT FROM 'organization_id=auth_org_id'
      OR policy_check IS DISTINCT FROM '' THEN
      RAISE EXCEPTION 'Security baseline policy %.% has an unexpected read-only definition', table_name, policy_name;
    END IF;
  END LOOP;

  -- Every remaining authenticated policy must retain a real tenant/user/parent
  -- predicate. This catches same-name permissive drift without rewriting it.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND roles && ARRAY['authenticated']::NAME[]
      AND (
        (cmd IN ('SELECT', 'UPDATE', 'DELETE', 'ALL') AND lower(coalesce(qual, '')) IN ('', 'true', '(true)'))
        OR (cmd IN ('INSERT', 'UPDATE', 'ALL') AND lower(coalesce(with_check, '')) IN ('true', '(true)'))
      )
  ) THEN
    RAISE EXCEPTION 'Security baseline refused an authenticated policy with a missing or universally true predicate';
  END IF;
END;
$$;

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
  crud_tables TEXT[] := ARRAY[
    'teams', 'companies', 'contacts', 'pipelines', 'deals', 'activities', 'tags',
    'calendar_events', 'conversations', 'documents', 'collections', 'workflows',
    'voice_assistants', 'webhook_endpoints'
  ];
BEGIN
  FOREACH table_name IN ARRAY crud_tables LOOP
    policy_name := table_name || '_select';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = auth_org_id())',
        policy_name,
        table_name
      );
    END IF;

    policy_name := table_name || '_insert';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = auth_org_id())',
        policy_name,
        table_name
      );
    END IF;

    policy_name := table_name || '_update';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = auth_org_id())',
        policy_name,
        table_name
      );
    END IF;

    policy_name := table_name || '_delete';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (organization_id = auth_org_id() AND auth_role() IN (''OWNER'', ''ADMIN'', ''MANAGER''))',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  table_name TEXT;
  policy_name TEXT;
  read_only_tables TEXT[] := ARRAY[
    'subscriptions', 'usage_records', 'voice_calls', 'workflow_runs',
    'invitations', 'api_keys', 'conversation_documents'
  ];
BEGIN
  FOREACH table_name IN ARRAY read_only_tables LOOP
    policy_name := table_name || '_select';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = auth_org_id())',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_self_select'
  ) THEN
    CREATE POLICY users_self_select ON public.users
      FOR SELECT TO authenticated USING (id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_self_update'
  ) THEN
    CREATE POLICY users_self_update ON public.users
      FOR UPDATE TO authenticated USING (id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'organizations' AND policyname = 'org_member_select'
  ) THEN
    CREATE POLICY org_member_select ON public.organizations
      FOR SELECT TO authenticated USING (id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'organization_members' AND policyname = 'members_select'
  ) THEN
    CREATE POLICY members_select ON public.organization_members
      FOR SELECT TO authenticated USING (organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'messages' AND policyname = 'messages_select'
  ) THEN
    CREATE POLICY messages_select ON public.messages
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.conversations AS conversation
          WHERE conversation.id = messages.conversation_id
            AND conversation.organization_id = auth_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'document_chunks' AND policyname = 'chunks_select'
  ) THEN
    CREATE POLICY chunks_select ON public.document_chunks
      FOR SELECT TO authenticated USING (organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pipeline_stages' AND policyname = 'stages_select'
  ) THEN
    CREATE POLICY stages_select ON public.pipeline_stages
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.pipelines AS pipeline
          WHERE pipeline.id = pipeline_stages.pipeline_id
            AND pipeline.organization_id = auth_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tags_on_contacts' AND policyname = 'contact_tags_select'
  ) THEN
    CREATE POLICY contact_tags_select ON public.tags_on_contacts
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.contacts AS contact
          WHERE contact.id = tags_on_contacts.contact_id
            AND contact.organization_id = auth_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'prompts' AND policyname = 'prompts_select'
  ) THEN
    CREATE POLICY prompts_select ON public.prompts
      FOR SELECT TO authenticated
      USING (organization_id IS NULL OR organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'prompts' AND policyname = 'prompts_insert'
  ) THEN
    CREATE POLICY prompts_insert ON public.prompts
      FOR INSERT TO authenticated WITH CHECK (organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'prompts' AND policyname = 'prompts_update'
  ) THEN
    CREATE POLICY prompts_update ON public.prompts
      FOR UPDATE TO authenticated USING (organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'prompts' AND policyname = 'prompts_delete'
  ) THEN
    CREATE POLICY prompts_delete ON public.prompts
      FOR DELETE TO authenticated
      USING (
        organization_id = auth_org_id()
        AND auth_role() IN ('OWNER', 'ADMIN', 'MANAGER')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_select'
  ) THEN
    CREATE POLICY notifications_select ON public.notifications
      FOR SELECT TO authenticated
      USING (user_id = auth.uid() AND organization_id = auth_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notifications' AND policyname = 'notifications_update'
  ) THEN
    CREATE POLICY notifications_update ON public.notifications
      FOR UPDATE TO authenticated USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_logs' AND policyname = 'audit_select'
  ) THEN
    CREATE POLICY audit_select ON public.audit_logs
      FOR SELECT TO authenticated
      USING (
        organization_id = auth_org_id()
        AND auth_role() IN ('OWNER', 'ADMIN')
      );
  END IF;
END $$;

-- Server-only tables intentionally receive no authenticated/public policies.
DO $$
DECLARE
  unexpected_policy RECORD;
BEGIN
  SELECT tablename, policyname
  INTO unexpected_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY (
      ARRAY[
        'calendar_connections', 'calendar_sync_states', 'booking_tokens',
        'reminders', 'document_upload_intents'
      ]
    )
    AND roles && ARRAY['authenticated', 'public']::name[]
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Security baseline refused authenticated/public policy %.% on a server-only table',
      unexpected_policy.tablename,
      unexpected_policy.policyname;
  END IF;
END $$;

SELECT pg_temp.assert_syveka_policy_contract();

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

COMMIT;
