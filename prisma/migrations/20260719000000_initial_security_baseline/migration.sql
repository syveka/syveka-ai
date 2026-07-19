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
