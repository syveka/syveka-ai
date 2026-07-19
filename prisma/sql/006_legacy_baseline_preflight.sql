-- Read-only compatibility preflight for databases created before the tracked
-- initial baseline. Run this before prisma migrate deploy.
-- BEGIN LEGACY BASELINE COMPATIBILITY CONTRACT
DO $syveka_contract$
DECLARE
  expected RECORD;
  actual_type TEXT;
  actual_not_null BOOLEAN;
  actual_columns TEXT[];
  actual_values TEXT[];
  missing_table TEXT;
  existing_table TEXT;
  baseline_tables TEXT[] := ARRAY[
    'users', 'organizations', 'organization_members', 'teams', 'invitations',
    'subscriptions', 'usage_records', 'companies', 'contacts', 'pipelines',
    'pipeline_stages', 'deals', 'activities', 'tags', 'tags_on_contacts',
    'calendar_events', 'event_attendees', 'calendar_connections',
    'external_calendars', 'calendar_sync_states', 'availability_schedules',
    'availability_rules', 'availability_overrides', 'booking_types', 'bookings',
    'booking_tokens', 'reminders', 'conversations', 'conversation_documents',
    'messages', 'collections', 'documents', 'document_upload_intents',
    'document_chunks', 'prompts', 'voice_assistants', 'voice_calls', 'workflows',
    'workflow_runs', 'notifications', 'api_keys', 'webhook_endpoints', 'audit_logs'
  ];
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    SELECT table_name
    INTO existing_table
    FROM unnest(baseline_tables) AS required(table_name)
    WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL
    LIMIT 1;

    IF existing_table IS NOT NULL THEN
      RAISE EXCEPTION
        'Syveka baseline refused a partially provisioned schema; found public.% without public.organizations',
        existing_table;
    END IF;
    RETURN;
  END IF;

  SELECT table_name
  INTO missing_table
  FROM unnest(baseline_tables) AS required(table_name)
  WHERE to_regclass(format('public.%I', table_name)) IS NULL
  LIMIT 1;

  IF missing_table IS NOT NULL THEN
    RAISE EXCEPTION
      'Syveka baseline refused an incomplete existing schema; missing public.%',
      missing_table;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('users', 'id', 'uuid', true),
      ('users', 'email', 'text', true),
      ('organizations', 'id', 'uuid', true),
      ('organizations', 'name', 'text', true),
      ('organizations', 'slug', 'text', true),
      ('organization_members', 'organization_id', 'uuid', true),
      ('organization_members', 'user_id', 'uuid', true),
      ('organization_members', 'role', 'Role', true),
      ('teams', 'organization_id', 'uuid', true),
      ('invitations', 'organization_id', 'uuid', true),
      ('invitations', 'email', 'text', true),
      ('subscriptions', 'organization_id', 'uuid', true),
      ('usage_records', 'organization_id', 'uuid', true),
      ('companies', 'organization_id', 'uuid', true),
      ('companies', 'name', 'text', true),
      ('contacts', 'organization_id', 'uuid', true),
      ('contacts', 'first_name', 'text', true),
      ('pipelines', 'organization_id', 'uuid', true),
      ('pipeline_stages', 'pipeline_id', 'uuid', true),
      ('deals', 'organization_id', 'uuid', true),
      ('deals', 'pipeline_id', 'uuid', true),
      ('deals', 'stage_id', 'uuid', true),
      ('activities', 'organization_id', 'uuid', true),
      ('activities', 'type', 'ActivityType', true),
      ('tags', 'organization_id', 'uuid', true),
      ('tags_on_contacts', 'contact_id', 'uuid', true),
      ('tags_on_contacts', 'tag_id', 'uuid', true),
      ('calendar_events', 'organization_id', 'uuid', true),
      ('calendar_events', 'starts_at', 'timestamp', true),
      ('calendar_events', 'ends_at', 'timestamp', true),
      ('event_attendees', 'event_id', 'uuid', true),
      ('calendar_connections', 'organization_id', 'uuid', true),
      ('calendar_connections', 'provider', 'CalendarProvider', true),
      ('external_calendars', 'organization_id', 'uuid', true),
      ('external_calendars', 'connection_id', 'uuid', true),
      ('calendar_sync_states', 'organization_id', 'uuid', true),
      ('calendar_sync_states', 'external_calendar_id', 'uuid', true),
      ('availability_schedules', 'organization_id', 'uuid', true),
      ('availability_rules', 'schedule_id', 'uuid', true),
      ('availability_overrides', 'schedule_id', 'uuid', true),
      ('booking_types', 'organization_id', 'uuid', true),
      ('booking_types', 'slug', 'text', true),
      ('bookings', 'organization_id', 'uuid', true),
      ('bookings', 'booking_type_id', 'uuid', true),
      ('booking_tokens', 'booking_id', 'uuid', true),
      ('booking_tokens', 'token_hash', 'text', true),
      ('reminders', 'organization_id', 'uuid', true),
      ('conversations', 'organization_id', 'uuid', true),
      ('conversations', 'user_id', 'uuid', true),
      ('conversation_documents', 'organization_id', 'uuid', true),
      ('conversation_documents', 'conversation_id', 'uuid', true),
      ('conversation_documents', 'document_id', 'uuid', true),
      ('messages', 'conversation_id', 'uuid', true),
      ('messages', 'role', 'MessageRole', true),
      ('collections', 'organization_id', 'uuid', true),
      ('documents', 'organization_id', 'uuid', true),
      ('documents', 'uploaded_by_id', 'uuid', true),
      ('document_upload_intents', 'organization_id', 'uuid', true),
      ('document_upload_intents', 'storage_path', 'text', true),
      ('document_chunks', 'organization_id', 'uuid', true),
      ('document_chunks', 'document_id', 'uuid', true),
      ('document_chunks', 'embedding', 'vector', false),
      ('prompts', 'organization_id', 'uuid', false),
      ('voice_assistants', 'organization_id', 'uuid', true),
      ('voice_calls', 'organization_id', 'uuid', true),
      ('workflows', 'organization_id', 'uuid', true),
      ('workflow_runs', 'organization_id', 'uuid', true),
      ('notifications', 'organization_id', 'uuid', true),
      ('notifications', 'user_id', 'uuid', true),
      ('api_keys', 'organization_id', 'uuid', true),
      ('webhook_endpoints', 'organization_id', 'uuid', true),
      ('audit_logs', 'organization_id', 'uuid', true)
    ) AS contract(table_name, column_name, type_name, not_null)
  LOOP
    SELECT data_type.typname, attribute.attnotnull
    INTO actual_type, actual_not_null
    FROM pg_attribute AS attribute
    JOIN pg_type AS data_type ON data_type.oid = attribute.atttypid
    WHERE attribute.attrelid = to_regclass(format('public.%I', expected.table_name))
      AND attribute.attname = expected.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF actual_type IS DISTINCT FROM expected.type_name
      OR actual_not_null IS DISTINCT FROM expected.not_null THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible column %.%: expected type % not_null %, found type % not_null %',
        expected.table_name, expected.column_name, expected.type_name,
        expected.not_null, actual_type, actual_not_null;
    END IF;
  END LOOP;

  FOR expected IN
    SELECT * FROM (VALUES
      ('users', 'users_pkey', ARRAY['id']::TEXT[]),
      ('organizations', 'organizations_pkey', ARRAY['id']::TEXT[]),
      ('organization_members', 'organization_members_pkey', ARRAY['id']::TEXT[]),
      ('companies', 'companies_pkey', ARRAY['id']::TEXT[]),
      ('contacts', 'contacts_pkey', ARRAY['id']::TEXT[]),
      ('pipelines', 'pipelines_pkey', ARRAY['id']::TEXT[]),
      ('pipeline_stages', 'pipeline_stages_pkey', ARRAY['id']::TEXT[]),
      ('deals', 'deals_pkey', ARRAY['id']::TEXT[]),
      ('activities', 'activities_pkey', ARRAY['id']::TEXT[]),
      ('tags_on_contacts', 'tags_on_contacts_pkey', ARRAY['contact_id', 'tag_id']::TEXT[]),
      ('calendar_events', 'calendar_events_pkey', ARRAY['id']::TEXT[]),
      ('event_attendees', 'event_attendees_pkey', ARRAY['id']::TEXT[]),
      ('calendar_connections', 'calendar_connections_pkey', ARRAY['id']::TEXT[]),
      ('external_calendars', 'external_calendars_pkey', ARRAY['id']::TEXT[]),
      ('calendar_sync_states', 'calendar_sync_states_pkey', ARRAY['id']::TEXT[]),
      ('availability_schedules', 'availability_schedules_pkey', ARRAY['id']::TEXT[]),
      ('availability_rules', 'availability_rules_pkey', ARRAY['id']::TEXT[]),
      ('availability_overrides', 'availability_overrides_pkey', ARRAY['id']::TEXT[]),
      ('booking_types', 'booking_types_pkey', ARRAY['id']::TEXT[]),
      ('bookings', 'bookings_pkey', ARRAY['id']::TEXT[]),
      ('booking_tokens', 'booking_tokens_pkey', ARRAY['id']::TEXT[]),
      ('reminders', 'reminders_pkey', ARRAY['id']::TEXT[]),
      ('conversations', 'conversations_pkey', ARRAY['id']::TEXT[]),
      ('conversation_documents', 'conversation_documents_pkey', ARRAY['id']::TEXT[]),
      ('messages', 'messages_pkey', ARRAY['id']::TEXT[]),
      ('documents', 'documents_pkey', ARRAY['id']::TEXT[]),
      ('document_upload_intents', 'document_upload_intents_pkey', ARRAY['id']::TEXT[]),
      ('document_chunks', 'document_chunks_pkey', ARRAY['id']::TEXT[]),
      ('workflows', 'workflows_pkey', ARRAY['id']::TEXT[]),
      ('audit_logs', 'audit_logs_pkey', ARRAY['id']::TEXT[])
    ) AS contract(table_name, constraint_name, columns)
  LOOP
    SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
    INTO actual_columns
    FROM pg_constraint AS constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
     AND attribute.attnum = key_column.attnum
    WHERE constraint_row.conrelid = to_regclass(format('public.%I', expected.table_name))
      AND constraint_row.conname = expected.constraint_name
      AND constraint_row.contype = 'p'
    GROUP BY constraint_row.oid;

    IF actual_columns IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible primary key %: expected %, found %',
        expected.constraint_name, expected.columns, actual_columns;
    END IF;
  END LOOP;

  FOR expected IN
    SELECT * FROM (VALUES
      ('users_email_key', ARRAY['email']::TEXT[], true),
      ('organizations_slug_key', ARRAY['slug']::TEXT[], true),
      ('organization_members_organization_id_user_id_key', ARRAY['organization_id', 'user_id']::TEXT[], true),
      ('subscriptions_organization_id_key', ARRAY['organization_id']::TEXT[], true),
      ('invitations_token_key', ARRAY['token']::TEXT[], true),
      ('pipeline_stages_pipeline_id_order_key', ARRAY['pipeline_id', 'order']::TEXT[], true),
      ('tags_organization_id_name_key', ARRAY['organization_id', 'name']::TEXT[], true),
      ('document_chunks_document_id_chunk_index_key', ARRAY['document_id', 'chunk_index']::TEXT[], true),
      ('contacts_organization_id_status_idx', ARRAY['organization_id', 'status']::TEXT[], false),
      ('deals_organization_id_stage_id_idx', ARRAY['organization_id', 'stage_id']::TEXT[], false),
      ('calendar_events_organization_id_starts_at_idx', ARRAY['organization_id', 'starts_at']::TEXT[], false),
      ('calendar_connections_organization_id_user_id_provider_key', ARRAY['organization_id', 'user_id', 'provider']::TEXT[], true),
      ('external_calendars_connection_id_external_id_key', ARRAY['connection_id', 'external_id']::TEXT[], true),
      ('calendar_sync_states_external_calendar_id_key', ARRAY['external_calendar_id']::TEXT[], true),
      ('booking_types_organization_id_slug_key', ARRAY['organization_id', 'slug']::TEXT[], true),
      ('booking_tokens_token_hash_key', ARRAY['token_hash']::TEXT[], true),
      ('reminders_dedupe_key_key', ARRAY['dedupe_key']::TEXT[], true),
      ('conversations_organization_id_user_id_updated_at_idx', ARRAY['organization_id', 'user_id', 'updated_at']::TEXT[], false),
      ('conversation_documents_conversation_id_document_id_key', ARRAY['conversation_id', 'document_id']::TEXT[], true),
      ('documents_organization_id_status_idx', ARRAY['organization_id', 'status']::TEXT[], false),
      ('document_upload_intents_storage_path_key', ARRAY['storage_path']::TEXT[], true),
      ('document_chunks_organization_id_idx', ARRAY['organization_id']::TEXT[], false),
      ('audit_logs_organization_id_created_at_idx', ARRAY['organization_id', 'created_at']::TEXT[], false)
    ) AS contract(index_name, columns, is_unique)
  LOOP
    SELECT array_agg(attribute.attname ORDER BY key_column.ordinality)
    INTO actual_columns
    FROM pg_class AS index_class
    JOIN pg_index AS index_row ON index_row.indexrelid = index_class.oid
    CROSS JOIN LATERAL unnest(index_row.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = index_row.indrelid
     AND attribute.attnum = key_column.attnum
    WHERE index_class.relnamespace = 'public'::regnamespace
      AND index_class.relname = expected.index_name
      AND index_row.indisunique = expected.is_unique
    GROUP BY index_row.indexrelid;

    IF actual_columns IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible index %: expected columns %, found %',
        expected.index_name, expected.columns, actual_columns;
    END IF;
  END LOOP;

  FOR expected IN
    SELECT * FROM (VALUES
      ('organization_members_organization_id_fkey'),
      ('companies_organization_id_fkey'),
      ('contacts_organization_id_fkey'),
      ('deals_organization_id_fkey'),
      ('activities_organization_id_fkey'),
      ('calendar_events_organization_id_fkey'),
      ('calendar_connections_organization_id_fkey'),
      ('external_calendars_organization_id_fkey'),
      ('calendar_sync_states_organization_id_fkey'),
      ('availability_schedules_organization_id_fkey'),
      ('booking_types_organization_id_fkey'),
      ('bookings_organization_id_fkey'),
      ('reminders_organization_id_fkey'),
      ('conversations_organization_id_fkey'),
      ('conversation_documents_organization_id_conversation_id_fkey'),
      ('conversation_documents_organization_id_document_id_fkey'),
      ('documents_organization_id_fkey'),
      ('document_upload_intents_organization_id_fkey'),
      ('document_chunks_organization_id_document_id_fkey'),
      ('documents_organization_id_collection_id_fkey')
    ) AS contract(constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = expected.constraint_name
        AND contype = 'f'
        AND convalidated
    ) THEN
      RAISE EXCEPTION
        'Syveka baseline missing validated tenant foreign key %',
        expected.constraint_name;
    END IF;
  END LOOP;

  FOR expected IN
    SELECT * FROM (VALUES
      ('Locale', ARRAY['EN', 'FI', 'AR']::TEXT[]),
      ('OrgType', ARRAY['PERSONAL', 'BUSINESS']::TEXT[]),
      ('Role', ARRAY['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER']::TEXT[]),
      ('InviteStatus', ARRAY['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED']::TEXT[]),
      ('Plan', ARRAY['FREE', 'STARTER', 'PRO', 'ENTERPRISE']::TEXT[]),
      ('ActivityType', ARRAY['NOTE', 'TASK', 'CALL', 'EMAIL', 'MEETING', 'VOICE_AI_CALL', 'AI_SUMMARY']::TEXT[]),
      ('EventSource', ARRAY['MANUAL', 'VOICE_AI', 'WORKFLOW', 'GOOGLE', 'OUTLOOK']::TEXT[]),
      ('CalendarProvider', ARRAY['GOOGLE', 'MICROSOFT', 'MOCK']::TEXT[]),
      ('BookingStatus', ARRAY['CONFIRMED', 'RESCHEDULED', 'CANCELED', 'COMPLETED']::TEXT[]),
      ('BookingTokenPurpose', ARRAY['MANAGE', 'CANCEL', 'RESCHEDULE']::TEXT[]),
      ('MessageRole', ARRAY['USER', 'ASSISTANT', 'SYSTEM', 'TOOL']::TEXT[]),
      ('DocStatus', ARRAY['PENDING', 'PROCESSING', 'READY', 'FAILED']::TEXT[])
    ) AS contract(enum_name, required_values)
  LOOP
    SELECT array_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder)
    INTO actual_values
    FROM pg_type AS enum_type
    JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
    JOIN pg_namespace AS enum_schema ON enum_schema.oid = enum_type.typnamespace
    WHERE enum_schema.nspname = 'public'
      AND enum_type.typname = expected.enum_name;

    IF actual_values IS NULL OR NOT expected.required_values <@ actual_values THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible enum %: required %, found %',
        expected.enum_name, expected.required_values, actual_values;
    END IF;
  END LOOP;
END
$syveka_contract$;
-- END LEGACY BASELINE COMPATIBILITY CONTRACT
