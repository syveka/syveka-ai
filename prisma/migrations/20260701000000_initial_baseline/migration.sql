BEGIN;

-- Syveka initial Prisma baseline.
--
-- The repository originally published its schema with `prisma db push` and
-- tracked only later feature migrations. This guarded baseline makes a clean
-- `prisma migrate deploy` possible without rewriting any published migration.
-- Existing databases are validated and left unchanged; partially provisioned
-- schemas are rejected instead of being guessed at or repaired implicitly.

-- BEGIN LEGACY BASELINE COMPATIBILITY CONTRACT
DO $syveka_contract$
DECLARE
  expected RECORD;
  actual_type TEXT;
  actual_not_null BOOLEAN;
  actual_identity TEXT;
  actual_generated TEXT;
  actual_default TEXT;
  actual_source_schema TEXT;
  actual_source_table TEXT;
  actual_target_schema TEXT;
  actual_target_table TEXT;
  actual_target_columns TEXT[];
  actual_delete_action TEXT;
  actual_update_action TEXT;
  actual_deferrable BOOLEAN;
  actual_initially_deferred BOOLEAN;
  actual_validated BOOLEAN;
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

  -- Every scalar column in the schema at main commit
  -- 6f6ab84f0f3849a172e0fdfdc49610058640d56c. Extra columns are allowed:
  -- they cannot weaken or replace any expected column definition.
  FOR expected IN
    SELECT * FROM (VALUES
      ('activities', 'body', 'text', 'false', '', '', ''),
      ('activities', 'company_id', 'uuid', 'false', '', '', ''),
      ('activities', 'completed_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('activities', 'contact_id', 'uuid', 'false', '', '', ''),
      ('activities', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('activities', 'deal_id', 'uuid', 'false', '', '', ''),
      ('activities', 'due_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('activities', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('activities', 'metadata', 'jsonb', 'true', '', '', '''{}'''),
      ('activities', 'organization_id', 'uuid', 'true', '', '', ''),
      ('activities', 'subject', 'text', 'true', '', '', ''),
      ('activities', 'type', '"ActivityType"', 'true', '', '', ''),
      ('activities', 'user_id', 'uuid', 'false', '', '', ''),
      ('api_keys', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('api_keys', 'expires_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('api_keys', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('api_keys', 'key_hash', 'text', 'true', '', '', ''),
      ('api_keys', 'last_used_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('api_keys', 'name', 'text', 'true', '', '', ''),
      ('api_keys', 'organization_id', 'uuid', 'true', '', '', ''),
      ('api_keys', 'prefix', 'text', 'true', '', '', ''),
      ('api_keys', 'revoked_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('api_keys', 'scopes', 'text[]', 'false', '', '', 'array[]'),
      ('audit_logs', 'action', 'text', 'true', '', '', ''),
      ('audit_logs', 'actor_id', 'uuid', 'false', '', '', ''),
      ('audit_logs', 'actorType', 'text', 'true', '', '', '''user'''),
      ('audit_logs', 'after', 'jsonb', 'false', '', '', ''),
      ('audit_logs', 'before', 'jsonb', 'false', '', '', ''),
      ('audit_logs', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('audit_logs', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('audit_logs', 'ip', 'text', 'false', '', '', ''),
      ('audit_logs', 'organization_id', 'uuid', 'true', '', '', ''),
      ('audit_logs', 'resource_id', 'text', 'false', '', '', ''),
      ('audit_logs', 'resource_type', 'text', 'true', '', '', ''),
      ('audit_logs', 'user_agent', 'text', 'false', '', '', ''),
      ('availability_overrides', 'date', 'date', 'true', '', '', ''),
      ('availability_overrides', 'end_minute', 'integer', 'false', '', '', ''),
      ('availability_overrides', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('availability_overrides', 'is_unavailable', 'boolean', 'true', '', '', 'false'),
      ('availability_overrides', 'schedule_id', 'uuid', 'true', '', '', ''),
      ('availability_overrides', 'start_minute', 'integer', 'false', '', '', ''),
      ('availability_rules', 'end_minute', 'integer', 'true', '', '', ''),
      ('availability_rules', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('availability_rules', 'schedule_id', 'uuid', 'true', '', '', ''),
      ('availability_rules', 'start_minute', 'integer', 'true', '', '', ''),
      ('availability_rules', 'weekday', 'integer', 'true', '', '', ''),
      ('availability_schedules', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('availability_schedules', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('availability_schedules', 'is_default', 'boolean', 'true', '', '', 'false'),
      ('availability_schedules', 'name', 'text', 'true', '', '', ''),
      ('availability_schedules', 'organization_id', 'uuid', 'true', '', '', ''),
      ('availability_schedules', 'timezone', 'text', 'true', '', '', '''europe/helsinki'''),
      ('availability_schedules', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('availability_schedules', 'user_id', 'uuid', 'true', '', '', ''),
      ('booking_tokens', 'booking_id', 'uuid', 'true', '', '', ''),
      ('booking_tokens', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('booking_tokens', 'expires_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('booking_tokens', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('booking_tokens', 'purpose', '"BookingTokenPurpose"', 'true', '', '', ''),
      ('booking_tokens', 'token_hash', 'text', 'true', '', '', ''),
      ('booking_tokens', 'used_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('booking_types', 'brand_color', 'text', 'false', '', '', ''),
      ('booking_types', 'buffer_after_minutes', 'integer', 'true', '', '', '0'),
      ('booking_types', 'buffer_before_minutes', 'integer', 'true', '', '', '0'),
      ('booking_types', 'collect_company', 'boolean', 'true', '', '', 'false'),
      ('booking_types', 'collect_phone', 'boolean', 'true', '', '', 'false'),
      ('booking_types', 'confirmation_message', 'text', 'false', '', '', ''),
      ('booking_types', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('booking_types', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('booking_types', 'description', 'text', 'false', '', '', ''),
      ('booking_types', 'duration_minutes', 'integer', 'true', '', '', '30'),
      ('booking_types', 'duration_options', 'integer[]', 'false', '', '', 'array[30]'),
      ('booking_types', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('booking_types', 'is_active', 'boolean', 'true', '', '', 'true'),
      ('booking_types', 'location', 'text', 'false', '', '', ''),
      ('booking_types', 'location_type', '"LocationType"', 'true', '', '', '''video'''),
      ('booking_types', 'max_window_days', 'integer', 'true', '', '', '60'),
      ('booking_types', 'min_notice_minutes', 'integer', 'true', '', '', '120'),
      ('booking_types', 'name', 'text', 'true', '', '', ''),
      ('booking_types', 'organization_id', 'uuid', 'true', '', '', ''),
      ('booking_types', 'owner_id', 'uuid', 'true', '', '', ''),
      ('booking_types', 'requires_consent', 'boolean', 'true', '', '', 'true'),
      ('booking_types', 'schedule_id', 'uuid', 'false', '', '', ''),
      ('booking_types', 'slug', 'text', 'true', '', '', ''),
      ('booking_types', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('bookings', 'booking_type_id', 'uuid', 'true', '', '', ''),
      ('bookings', 'cancel_reason', 'text', 'false', '', '', ''),
      ('bookings', 'canceled_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('bookings', 'consent_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('bookings', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('bookings', 'ends_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('bookings', 'event_id', 'uuid', 'false', '', '', ''),
      ('bookings', 'guest_company', 'text', 'false', '', '', ''),
      ('bookings', 'guest_email', 'text', 'true', '', '', ''),
      ('bookings', 'guest_locale', '"Locale"', 'false', '', '', ''),
      ('bookings', 'guest_name', 'text', 'true', '', '', ''),
      ('bookings', 'guest_notes', 'text', 'false', '', '', ''),
      ('bookings', 'guest_phone', 'text', 'false', '', '', ''),
      ('bookings', 'guest_timezone', 'text', 'true', '', '', '''europe/helsinki'''),
      ('bookings', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('bookings', 'organization_id', 'uuid', 'true', '', '', ''),
      ('bookings', 'rescheduled_from_id', 'uuid', 'false', '', '', ''),
      ('bookings', 'starts_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('bookings', 'status', '"BookingStatus"', 'true', '', '', '''confirmed'''),
      ('bookings', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_connections', 'access_token_enc', 'text', 'false', '', '', ''),
      ('calendar_connections', 'account_email', 'text', 'false', '', '', ''),
      ('calendar_connections', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('calendar_connections', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('calendar_connections', 'last_checked_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_connections', 'last_error', 'text', 'false', '', '', ''),
      ('calendar_connections', 'organization_id', 'uuid', 'true', '', '', ''),
      ('calendar_connections', 'provider', '"CalendarProvider"', 'true', '', '', ''),
      ('calendar_connections', 'refresh_token_enc', 'text', 'false', '', '', ''),
      ('calendar_connections', 'scopes', 'text[]', 'false', '', '', 'array[]'),
      ('calendar_connections', 'status', '"ConnectionStatus"', 'true', '', '', '''connected'''),
      ('calendar_connections', 'token_expires_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_connections', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_connections', 'user_id', 'uuid', 'true', '', '', ''),
      ('calendar_events', 'all_day', 'boolean', 'true', '', '', 'false'),
      ('calendar_events', 'attendees', 'jsonb', 'true', '', '', '''[]'''),
      ('calendar_events', 'canceled_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_events', 'company_id', 'uuid', 'false', '', '', ''),
      ('calendar_events', 'contact_id', 'uuid', 'false', '', '', ''),
      ('calendar_events', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('calendar_events', 'created_by_id', 'uuid', 'true', '', '', ''),
      ('calendar_events', 'deal_id', 'uuid', 'false', '', '', ''),
      ('calendar_events', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_events', 'description', 'text', 'false', '', '', ''),
      ('calendar_events', 'ends_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_events', 'external_calendar_id', 'uuid', 'false', '', '', ''),
      ('calendar_events', 'external_etag', 'text', 'false', '', '', ''),
      ('calendar_events', 'external_id', 'text', 'false', '', '', ''),
      ('calendar_events', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('calendar_events', 'location', 'text', 'false', '', '', ''),
      ('calendar_events', 'organization_id', 'uuid', 'true', '', '', ''),
      ('calendar_events', 'owner_id', 'uuid', 'false', '', '', ''),
      ('calendar_events', 'recurrence_rule', 'text', 'false', '', '', ''),
      ('calendar_events', 'source', '"EventSource"', 'true', '', '', '''manual'''),
      ('calendar_events', 'starts_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_events', 'status', '"EventStatus"', 'true', '', '', '''confirmed'''),
      ('calendar_events', 'timezone', 'text', 'true', '', '', '''europe/helsinki'''),
      ('calendar_events', 'title', 'text', 'true', '', '', ''),
      ('calendar_events', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_sync_states', 'external_calendar_id', 'uuid', 'true', '', '', ''),
      ('calendar_sync_states', 'failure_count', 'integer', 'true', '', '', '0'),
      ('calendar_sync_states', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('calendar_sync_states', 'last_sync_status', 'text', 'false', '', '', ''),
      ('calendar_sync_states', 'last_synced_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_sync_states', 'organization_id', 'uuid', 'true', '', '', ''),
      ('calendar_sync_states', 'sync_cursor', 'text', 'false', '', '', ''),
      ('calendar_sync_states', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('calendar_sync_states', 'webhook_expires_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('calendar_sync_states', 'webhook_resource_id', 'text', 'false', '', '', ''),
      ('calendar_sync_states', 'webhook_subscription_id', 'text', 'false', '', '', ''),
      ('collections', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('collections', 'description', 'text', 'false', '', '', ''),
      ('collections', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('collections', 'name', 'text', 'true', '', '', ''),
      ('collections', 'organization_id', 'uuid', 'true', '', '', ''),
      ('companies', 'address', 'jsonb', 'false', '', '', ''),
      ('companies', 'archived_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('companies', 'business_id', 'text', 'false', '', '', ''),
      ('companies', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('companies', 'custom_fields', 'jsonb', 'true', '', '', '''{}'''),
      ('companies', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('companies', 'domain', 'text', 'false', '', '', ''),
      ('companies', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('companies', 'industry', 'text', 'false', '', '', ''),
      ('companies', 'name', 'text', 'true', '', '', ''),
      ('companies', 'organization_id', 'uuid', 'true', '', '', ''),
      ('companies', 'size', 'text', 'false', '', '', ''),
      ('companies', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('companies', 'website', 'text', 'false', '', '', ''),
      ('contacts', 'archived_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('contacts', 'company_id', 'uuid', 'false', '', '', ''),
      ('contacts', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('contacts', 'custom_fields', 'jsonb', 'true', '', '', '''{}'''),
      ('contacts', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('contacts', 'email', 'text', 'false', '', '', ''),
      ('contacts', 'first_name', 'text', 'true', '', '', ''),
      ('contacts', 'gdpr_consent_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('contacts', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('contacts', 'last_name', 'text', 'false', '', '', ''),
      ('contacts', 'locale', '"Locale"', 'false', '', '', ''),
      ('contacts', 'organization_id', 'uuid', 'true', '', '', ''),
      ('contacts', 'owner_id', 'uuid', 'false', '', '', ''),
      ('contacts', 'phone', 'text', 'false', '', '', ''),
      ('contacts', 'source', 'text', 'false', '', '', ''),
      ('contacts', 'status', '"ContactStatus"', 'true', '', '', '''lead'''),
      ('contacts', 'title', 'text', 'false', '', '', ''),
      ('contacts', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('conversation_documents', 'conversation_id', 'uuid', 'true', '', '', ''),
      ('conversation_documents', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('conversation_documents', 'document_id', 'uuid', 'true', '', '', ''),
      ('conversation_documents', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('conversation_documents', 'organization_id', 'uuid', 'true', '', '', ''),
      ('conversations', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('conversations', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('conversations', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('conversations', 'is_pinned', 'boolean', 'true', '', '', 'false'),
      ('conversations', 'is_shared', 'boolean', 'true', '', '', 'false'),
      ('conversations', 'model', 'text', 'false', '', '', ''),
      ('conversations', 'organization_id', 'uuid', 'true', '', '', ''),
      ('conversations', 'summary', 'text', 'false', '', '', ''),
      ('conversations', 'summary_message_count', 'integer', 'true', '', '', '0'),
      ('conversations', 'summary_updated_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('conversations', 'system_prompt_id', 'uuid', 'false', '', '', ''),
      ('conversations', 'title', 'text', 'true', '', '', '''new conversation'''),
      ('conversations', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('conversations', 'user_id', 'uuid', 'true', '', '', ''),
      ('deals', 'closed_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('deals', 'company_id', 'uuid', 'false', '', '', ''),
      ('deals', 'contact_id', 'uuid', 'false', '', '', ''),
      ('deals', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('deals', 'currency', 'text', 'true', '', '', '''eur'''),
      ('deals', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('deals', 'expected_close_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('deals', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('deals', 'lost_reason', 'text', 'false', '', '', ''),
      ('deals', 'organization_id', 'uuid', 'true', '', '', ''),
      ('deals', 'owner_id', 'uuid', 'false', '', '', ''),
      ('deals', 'pipeline_id', 'uuid', 'true', '', '', ''),
      ('deals', 'position', 'integer', 'true', '', '', '0'),
      ('deals', 'probability', 'integer', 'false', '', '', ''),
      ('deals', 'stage_id', 'uuid', 'true', '', '', ''),
      ('deals', 'title', 'text', 'true', '', '', ''),
      ('deals', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('deals', 'value_cents', 'integer', 'true', '', '', '0'),
      ('document_chunks', 'chunk_index', 'integer', 'true', '', '', ''),
      ('document_chunks', 'content', 'text', 'true', '', '', ''),
      ('document_chunks', 'document_id', 'uuid', 'true', '', '', ''),
      ('document_chunks', 'embedding', 'vector(1536)', 'false', '', '', ''),
      ('document_chunks', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('document_chunks', 'metadata', 'jsonb', 'true', '', '', '''{}'''),
      ('document_chunks', 'organization_id', 'uuid', 'true', '', '', ''),
      ('document_chunks', 'token_count', 'integer', 'true', '', '', ''),
      ('document_upload_intents', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('document_upload_intents', 'expected_mime_type', 'text', 'true', '', '', ''),
      ('document_upload_intents', 'expires_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('document_upload_intents', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('document_upload_intents', 'max_size_bytes', 'integer', 'true', '', '', ''),
      ('document_upload_intents', 'organization_id', 'uuid', 'true', '', '', ''),
      ('document_upload_intents', 'storage_path', 'text', 'true', '', '', ''),
      ('document_upload_intents', 'used_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('document_upload_intents', 'user_id', 'uuid', 'true', '', '', ''),
      ('documents', 'chunk_count', 'integer', 'true', '', '', '0'),
      ('documents', 'collection_id', 'uuid', 'false', '', '', ''),
      ('documents', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('documents', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('documents', 'error', 'text', 'false', '', '', ''),
      ('documents', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('documents', 'language', '"Locale"', 'false', '', '', ''),
      ('documents', 'mime_type', 'text', 'false', '', '', ''),
      ('documents', 'organization_id', 'uuid', 'true', '', '', ''),
      ('documents', 'size_bytes', 'integer', 'false', '', '', ''),
      ('documents', 'source_type', '"DocSource"', 'true', '', '', ''),
      ('documents', 'source_url', 'text', 'false', '', '', ''),
      ('documents', 'status', '"DocStatus"', 'true', '', '', '''pending'''),
      ('documents', 'storage_path', 'text', 'false', '', '', ''),
      ('documents', 'title', 'text', 'true', '', '', ''),
      ('documents', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('documents', 'uploaded_by_id', 'uuid', 'true', '', '', ''),
      ('event_attendees', 'contact_id', 'uuid', 'false', '', '', ''),
      ('event_attendees', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('event_attendees', 'email', 'text', 'false', '', '', ''),
      ('event_attendees', 'event_id', 'uuid', 'true', '', '', ''),
      ('event_attendees', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('event_attendees', 'is_organizer', 'boolean', 'true', '', '', 'false'),
      ('event_attendees', 'name', 'text', 'false', '', '', ''),
      ('event_attendees', 'status', '"AttendeeStatus"', 'true', '', '', '''pending'''),
      ('event_attendees', 'user_id', 'uuid', 'false', '', '', ''),
      ('external_calendars', 'connection_id', 'uuid', 'true', '', '', ''),
      ('external_calendars', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('external_calendars', 'external_id', 'text', 'true', '', '', ''),
      ('external_calendars', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('external_calendars', 'is_primary', 'boolean', 'true', '', '', 'false'),
      ('external_calendars', 'name', 'text', 'true', '', '', ''),
      ('external_calendars', 'organization_id', 'uuid', 'true', '', '', ''),
      ('external_calendars', 'sync_enabled', 'boolean', 'true', '', '', 'false'),
      ('external_calendars', 'timezone', 'text', 'false', '', '', ''),
      ('invitations', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('invitations', 'email', 'text', 'true', '', '', ''),
      ('invitations', 'expires_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('invitations', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('invitations', 'invited_by_id', 'uuid', 'true', '', '', ''),
      ('invitations', 'organization_id', 'uuid', 'true', '', '', ''),
      ('invitations', 'role', '"Role"', 'true', '', '', '''member'''),
      ('invitations', 'status', '"InviteStatus"', 'true', '', '', '''pending'''),
      ('invitations', 'token', 'text', 'true', '', '', 'gen_random_uuid'),
      ('messages', 'citations', 'jsonb', 'false', '', '', ''),
      ('messages', 'content', 'text', 'true', '', '', ''),
      ('messages', 'conversation_id', 'uuid', 'true', '', '', ''),
      ('messages', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('messages', 'estimated_cost_usd', 'numeric(12,8)', 'false', '', '', ''),
      ('messages', 'feedback', 'integer', 'false', '', '', ''),
      ('messages', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('messages', 'latency_ms', 'integer', 'false', '', '', ''),
      ('messages', 'model', 'text', 'false', '', '', ''),
      ('messages', 'role', '"MessageRole"', 'true', '', '', ''),
      ('messages', 'tokens_in', 'integer', 'false', '', '', ''),
      ('messages', 'tokens_out', 'integer', 'false', '', '', ''),
      ('messages', 'tool_calls', 'jsonb', 'false', '', '', ''),
      ('messages', 'user_id', 'uuid', 'false', '', '', ''),
      ('notifications', 'body', 'text', 'false', '', '', ''),
      ('notifications', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('notifications', 'href', 'text', 'false', '', '', ''),
      ('notifications', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('notifications', 'organization_id', 'uuid', 'true', '', '', ''),
      ('notifications', 'read_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('notifications', 'title', 'text', 'true', '', '', ''),
      ('notifications', 'type', 'text', 'true', '', '', ''),
      ('notifications', 'user_id', 'uuid', 'true', '', '', ''),
      ('organization_members', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('organization_members', 'joined_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('organization_members', 'organization_id', 'uuid', 'true', '', '', ''),
      ('organization_members', 'role', '"Role"', 'true', '', '', '''member'''),
      ('organization_members', 'team_id', 'uuid', 'false', '', '', ''),
      ('organization_members', 'user_id', 'uuid', 'true', '', '', ''),
      ('organizations', 'business_id', 'text', 'false', '', '', ''),
      ('organizations', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('organizations', 'defaultLocale', '"Locale"', 'true', '', '', '''fi'''),
      ('organizations', 'deleted_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('organizations', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('organizations', 'logo_url', 'text', 'false', '', '', ''),
      ('organizations', 'name', 'text', 'true', '', '', ''),
      ('organizations', 'settings', 'jsonb', 'true', '', '', '''{}'''),
      ('organizations', 'slug', 'text', 'true', '', '', ''),
      ('organizations', 'stripe_customer_id', 'text', 'false', '', '', ''),
      ('organizations', 'type', '"OrgType"', 'true', '', '', '''business'''),
      ('organizations', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('organizations', 'vat_id', 'text', 'false', '', '', ''),
      ('pipeline_stages', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('pipeline_stages', 'is_lost', 'boolean', 'true', '', '', 'false'),
      ('pipeline_stages', 'is_won', 'boolean', 'true', '', '', 'false'),
      ('pipeline_stages', 'name', 'text', 'true', '', '', ''),
      ('pipeline_stages', 'order', 'integer', 'true', '', '', ''),
      ('pipeline_stages', 'pipeline_id', 'uuid', 'true', '', '', ''),
      ('pipeline_stages', 'probability', 'integer', 'true', '', '', '0'),
      ('pipelines', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('pipelines', 'is_default', 'boolean', 'true', '', '', 'false'),
      ('pipelines', 'name', 'text', 'true', '', '', ''),
      ('pipelines', 'organization_id', 'uuid', 'true', '', '', ''),
      ('prompts', 'category', 'text', 'true', '', '', '''general'''),
      ('prompts', 'content', 'text', 'true', '', '', ''),
      ('prompts', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('prompts', 'created_by_id', 'uuid', 'false', '', '', ''),
      ('prompts', 'description', 'text', 'false', '', '', ''),
      ('prompts', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('prompts', 'is_published', 'boolean', 'true', '', '', 'true'),
      ('prompts', 'locale', '"Locale"', 'true', '', '', '''fi'''),
      ('prompts', 'organization_id', 'uuid', 'false', '', '', ''),
      ('prompts', 'title', 'text', 'true', '', '', ''),
      ('prompts', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('prompts', 'usage_count', 'integer', 'true', '', '', '0'),
      ('prompts', 'variables', 'jsonb', 'true', '', '', '''[]'''),
      ('reminders', 'attempts', 'integer', 'true', '', '', '0'),
      ('reminders', 'channel', '"ReminderChannel"', 'true', '', '', '''email'''),
      ('reminders', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('reminders', 'dedupe_key', 'text', 'true', '', '', ''),
      ('reminders', 'event_id', 'uuid', 'false', '', '', ''),
      ('reminders', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('reminders', 'last_error', 'text', 'false', '', '', ''),
      ('reminders', 'organization_id', 'uuid', 'true', '', '', ''),
      ('reminders', 'send_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('reminders', 'sent_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('reminders', 'status', '"ReminderStatus"', 'true', '', '', '''scheduled'''),
      ('subscriptions', 'cancel_at_period_end', 'boolean', 'true', '', '', 'false'),
      ('subscriptions', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('subscriptions', 'current_period_end', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('subscriptions', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('subscriptions', 'organization_id', 'uuid', 'true', '', '', ''),
      ('subscriptions', 'plan', '"Plan"', 'true', '', '', '''free'''),
      ('subscriptions', 'seats', 'integer', 'true', '', '', '1'),
      ('subscriptions', 'status', '"SubStatus"', 'true', '', '', '''active'''),
      ('subscriptions', 'stripe_subscription_id', 'text', 'false', '', '', ''),
      ('subscriptions', 'trial_ends_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('subscriptions', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('tags', 'color', 'text', 'true', '', '', '''#6366f1'''),
      ('tags', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('tags', 'name', 'text', 'true', '', '', ''),
      ('tags', 'organization_id', 'uuid', 'true', '', '', ''),
      ('tags_on_contacts', 'contact_id', 'uuid', 'true', '', '', ''),
      ('tags_on_contacts', 'tag_id', 'uuid', 'true', '', '', ''),
      ('teams', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('teams', 'description', 'text', 'false', '', '', ''),
      ('teams', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('teams', 'name', 'text', 'true', '', '', ''),
      ('teams', 'organization_id', 'uuid', 'true', '', '', ''),
      ('usage_records', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('usage_records', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('usage_records', 'metadata', 'jsonb', 'true', '', '', '''{}'''),
      ('usage_records', 'metric', '"UsageMetric"', 'true', '', '', ''),
      ('usage_records', 'organization_id', 'uuid', 'true', '', '', ''),
      ('usage_records', 'period_start', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('usage_records', 'quantity', 'integer', 'true', '', '', ''),
      ('users', 'avatar_url', 'text', 'false', '', '', ''),
      ('users', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('users', 'email', 'text', 'true', '', '', ''),
      ('users', 'full_name', 'text', 'false', '', '', ''),
      ('users', 'id', 'uuid', 'true', '', '', ''),
      ('users', 'locale', '"Locale"', 'true', '', '', '''fi'''),
      ('users', 'onboarded_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('users', 'timezone', 'text', 'true', '', '', '''europe/helsinki'''),
      ('users', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('voice_assistants', 'business_hours', 'jsonb', 'false', '', '', ''),
      ('voice_assistants', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('voice_assistants', 'enabled_tools', 'jsonb', 'true', '', '', '''[]'''),
      ('voice_assistants', 'first_message', 'text', 'true', '', '', ''),
      ('voice_assistants', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('voice_assistants', 'is_active', 'boolean', 'true', '', '', 'false'),
      ('voice_assistants', 'language', '"Locale"', 'true', '', '', '''fi'''),
      ('voice_assistants', 'name', 'text', 'true', '', '', ''),
      ('voice_assistants', 'organization_id', 'uuid', 'true', '', '', ''),
      ('voice_assistants', 'phone_number', 'text', 'false', '', '', ''),
      ('voice_assistants', 'system_prompt', 'text', 'true', '', '', ''),
      ('voice_assistants', 'transfer_number', 'text', 'false', '', '', ''),
      ('voice_assistants', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('voice_assistants', 'use_knowledge_base', 'boolean', 'true', '', '', 'true'),
      ('voice_assistants', 'vapi_assistant_id', 'text', 'false', '', '', ''),
      ('voice_assistants', 'voiceId', 'text', 'false', '', '', ''),
      ('voice_assistants', 'voiceProvider', 'text', 'true', '', '', '''azure'''),
      ('voice_calls', 'actions_taken', 'jsonb', 'true', '', '', '''[]'''),
      ('voice_calls', 'assistant_id', 'uuid', 'true', '', '', ''),
      ('voice_calls', 'caller_number', 'text', 'false', '', '', ''),
      ('voice_calls', 'contact_id', 'uuid', 'false', '', '', ''),
      ('voice_calls', 'cost_cents', 'integer', 'false', '', '', ''),
      ('voice_calls', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('voice_calls', 'direction', '"CallDirection"', 'true', '', '', '''inbound'''),
      ('voice_calls', 'duration_seconds', 'integer', 'false', '', '', ''),
      ('voice_calls', 'ended_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('voice_calls', 'ended_reason', 'text', 'false', '', '', ''),
      ('voice_calls', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('voice_calls', 'organization_id', 'uuid', 'true', '', '', ''),
      ('voice_calls', 'recording_url', 'text', 'false', '', '', ''),
      ('voice_calls', 'sentiment', 'text', 'false', '', '', ''),
      ('voice_calls', 'started_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('voice_calls', 'status', '"CallStatus"', 'true', '', '', '''in_progress'''),
      ('voice_calls', 'summary', 'text', 'false', '', '', ''),
      ('voice_calls', 'transcript', 'jsonb', 'false', '', '', ''),
      ('voice_calls', 'vapi_call_id', 'text', 'true', '', '', ''),
      ('webhook_endpoints', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('webhook_endpoints', 'events', 'text[]', 'false', '', '', ''),
      ('webhook_endpoints', 'failure_count', 'integer', 'true', '', '', '0'),
      ('webhook_endpoints', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('webhook_endpoints', 'is_active', 'boolean', 'true', '', '', 'true'),
      ('webhook_endpoints', 'organization_id', 'uuid', 'true', '', '', ''),
      ('webhook_endpoints', 'secret', 'text', 'true', '', '', ''),
      ('webhook_endpoints', 'url', 'text', 'true', '', '', ''),
      ('workflow_runs', 'error', 'text', 'false', '', '', ''),
      ('workflow_runs', 'finished_at', 'timestamp(3) without time zone', 'false', '', '', ''),
      ('workflow_runs', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('workflow_runs', 'organization_id', 'uuid', 'true', '', '', ''),
      ('workflow_runs', 'started_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('workflow_runs', 'status', '"RunStatus"', 'true', '', '', '''running'''),
      ('workflow_runs', 'step_results', 'jsonb', 'true', '', '', '''[]'''),
      ('workflow_runs', 'trigger_data', 'jsonb', 'true', '', '', ''),
      ('workflow_runs', 'workflow_id', 'uuid', 'true', '', '', ''),
      ('workflows', 'created_at', 'timestamp(3) without time zone', 'true', '', '', 'current_timestamp'),
      ('workflows', 'created_by_id', 'uuid', 'true', '', '', ''),
      ('workflows', 'description', 'text', 'false', '', '', ''),
      ('workflows', 'id', 'uuid', 'true', '', '', 'gen_random_uuid'),
      ('workflows', 'is_active', 'boolean', 'true', '', '', 'false'),
      ('workflows', 'name', 'text', 'true', '', '', ''),
      ('workflows', 'organization_id', 'uuid', 'true', '', '', ''),
      ('workflows', 'steps', 'jsonb', 'true', '', '', ''),
      ('workflows', 'trigger', 'jsonb', 'true', '', '', ''),
      ('workflows', 'updated_at', 'timestamp(3) without time zone', 'true', '', '', ''),
      ('workflows', 'version', 'integer', 'true', '', '', '1')
    ) AS contract(
      table_name, column_name, formatted_type, not_null,
      identity_kind, generated_kind, normalized_default
    )
  LOOP
    SELECT
      format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull,
      attribute.attidentity::TEXT,
      attribute.attgenerated::TEXT,
      regexp_replace(
        regexp_replace(
          lower(coalesce(pg_get_expr(default_row.adbin, default_row.adrelid), '')),
          '::("[^"]+"|[a-z_][a-z0-9_]*)(\[\])?',
          '',
          'g'
        ),
        '[[:space:]()]',
        '',
        'g'
      )
    INTO
      actual_type, actual_not_null, actual_identity, actual_generated,
      actual_default
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = to_regclass(format('public.%I', expected.table_name))
      AND attribute.attname = expected.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF actual_type IS DISTINCT FROM expected.formatted_type
      OR actual_not_null IS DISTINCT FROM expected.not_null::BOOLEAN
      OR actual_identity IS DISTINCT FROM expected.identity_kind
      OR actual_generated IS DISTINCT FROM expected.generated_kind
      OR actual_default IS DISTINCT FROM expected.normalized_default THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible column %.%: expected type %, not_null %, identity %, generated %, default %; found type %, not_null %, identity %, generated %, default %',
        expected.table_name, expected.column_name, expected.formatted_type,
        expected.not_null, expected.identity_kind, expected.generated_kind,
        expected.normalized_default, actual_type, actual_not_null,
        actual_identity, actual_generated, actual_default;
    END IF;
  END LOOP;

  -- Complete relationship contract. Names alone are insufficient: both
  -- ordered endpoints, actions, validation, and deferrability must agree.
  FOR expected IN
    SELECT * FROM (VALUES
      ('public', 'organization_members', 'organization_members_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'organization_members', 'organization_members_user_id_fkey', '{user_id}', 'public', 'users', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'organization_members', 'organization_members_team_id_fkey', '{team_id}', 'public', 'teams', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'teams', 'teams_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'invitations', 'invitations_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'subscriptions', 'subscriptions_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'usage_records', 'usage_records_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'companies', 'companies_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'contacts', 'contacts_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'contacts', 'contacts_company_id_fkey', '{company_id}', 'public', 'companies', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'pipelines', 'pipelines_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'pipeline_stages', 'pipeline_stages_pipeline_id_fkey', '{pipeline_id}', 'public', 'pipelines', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'deals', 'deals_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'deals', 'deals_pipeline_id_fkey', '{pipeline_id}', 'public', 'pipelines', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'deals', 'deals_stage_id_fkey', '{stage_id}', 'public', 'pipeline_stages', '{id}', 'Restrict', 'Cascade', 'false', 'false', 'true'),
      ('public', 'deals', 'deals_contact_id_fkey', '{contact_id}', 'public', 'contacts', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'deals', 'deals_company_id_fkey', '{company_id}', 'public', 'companies', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'activities', 'activities_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'activities', 'activities_user_id_fkey', '{user_id}', 'public', 'users', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'activities', 'activities_contact_id_fkey', '{contact_id}', 'public', 'contacts', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'activities', 'activities_company_id_fkey', '{company_id}', 'public', 'companies', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'activities', 'activities_deal_id_fkey', '{deal_id}', 'public', 'deals', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'tags', 'tags_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'tags_on_contacts', 'tags_on_contacts_contact_id_fkey', '{contact_id}', 'public', 'contacts', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'tags_on_contacts', 'tags_on_contacts_tag_id_fkey', '{tag_id}', 'public', 'tags', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'calendar_events', 'calendar_events_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'calendar_events', 'calendar_events_external_calendar_id_fkey', '{external_calendar_id}', 'public', 'external_calendars', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'event_attendees', 'event_attendees_event_id_fkey', '{event_id}', 'public', 'calendar_events', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'event_attendees', 'event_attendees_contact_id_fkey', '{contact_id}', 'public', 'contacts', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'calendar_connections', 'calendar_connections_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'external_calendars', 'external_calendars_connection_id_fkey', '{connection_id}', 'public', 'calendar_connections', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'external_calendars', 'external_calendars_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'calendar_sync_states', 'calendar_sync_states_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'calendar_sync_states', 'calendar_sync_states_external_calendar_id_fkey', '{external_calendar_id}', 'public', 'external_calendars', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'availability_schedules', 'availability_schedules_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'availability_rules', 'availability_rules_schedule_id_fkey', '{schedule_id}', 'public', 'availability_schedules', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'availability_overrides', 'availability_overrides_schedule_id_fkey', '{schedule_id}', 'public', 'availability_schedules', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'booking_types', 'booking_types_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'booking_types', 'booking_types_schedule_id_fkey', '{schedule_id}', 'public', 'availability_schedules', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'bookings', 'bookings_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'bookings', 'bookings_booking_type_id_fkey', '{booking_type_id}', 'public', 'booking_types', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'bookings', 'bookings_event_id_fkey', '{event_id}', 'public', 'calendar_events', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'bookings', 'bookings_rescheduled_from_id_fkey', '{rescheduled_from_id}', 'public', 'bookings', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'booking_tokens', 'booking_tokens_booking_id_fkey', '{booking_id}', 'public', 'bookings', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'reminders', 'reminders_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'reminders', 'reminders_event_id_fkey', '{event_id}', 'public', 'calendar_events', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'conversations', 'conversations_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'messages', 'messages_conversation_id_fkey', '{conversation_id}', 'public', 'conversations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'messages', 'messages_user_id_fkey', '{user_id}', 'public', 'users', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true'),
      ('public', 'collections', 'collections_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'documents', 'documents_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'documents', 'documents_organization_id_collection_id_fkey', '{organization_id,collection_id}', 'public', 'collections', '{organization_id,id}', 'Restrict', 'Cascade', 'false', 'false', 'true'),
      ('public', 'conversation_documents', 'conversation_documents_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'conversation_documents', 'conversation_documents_organization_id_conversation_id_fkey', '{organization_id,conversation_id}', 'public', 'conversations', '{organization_id,id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'conversation_documents', 'conversation_documents_organization_id_document_id_fkey', '{organization_id,document_id}', 'public', 'documents', '{organization_id,id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'document_upload_intents', 'document_upload_intents_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'document_upload_intents', 'document_upload_intents_user_id_fkey', '{user_id}', 'public', 'users', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'document_chunks', 'document_chunks_organization_id_document_id_fkey', '{organization_id,document_id}', 'public', 'documents', '{organization_id,id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'prompts', 'prompts_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'voice_assistants', 'voice_assistants_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'voice_calls', 'voice_calls_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'voice_calls', 'voice_calls_assistant_id_fkey', '{assistant_id}', 'public', 'voice_assistants', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'workflows', 'workflows_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'workflow_runs', 'workflow_runs_workflow_id_fkey', '{workflow_id}', 'public', 'workflows', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'workflow_runs', 'workflow_runs_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'notifications', 'notifications_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'notifications', 'notifications_user_id_fkey', '{user_id}', 'public', 'users', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'api_keys', 'api_keys_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'webhook_endpoints', 'webhook_endpoints_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'audit_logs', 'audit_logs_organization_id_fkey', '{organization_id}', 'public', 'organizations', '{id}', 'Cascade', 'Cascade', 'false', 'false', 'true'),
      ('public', 'audit_logs', 'audit_logs_actor_id_fkey', '{actor_id}', 'public', 'users', '{id}', 'SetNull', 'Cascade', 'false', 'false', 'true')
    ) AS contract(
      source_schema, source_table, constraint_name, source_columns,
      target_schema, target_table, target_columns, delete_action,
      update_action, is_deferrable, initially_deferred, is_validated
    )
  LOOP
    SELECT
      source_namespace.nspname,
      source_table.relname,
      array_agg(source_attribute.attname ORDER BY source_key.ordinality),
      target_namespace.nspname,
      target_table.relname,
      array_agg(target_attribute.attname ORDER BY source_key.ordinality),
      CASE constraint_row.confdeltype
        WHEN 'a' THEN 'NoAction' WHEN 'r' THEN 'Restrict'
        WHEN 'c' THEN 'Cascade' WHEN 'n' THEN 'SetNull'
        WHEN 'd' THEN 'SetDefault'
      END,
      CASE constraint_row.confupdtype
        WHEN 'a' THEN 'NoAction' WHEN 'r' THEN 'Restrict'
        WHEN 'c' THEN 'Cascade' WHEN 'n' THEN 'SetNull'
        WHEN 'd' THEN 'SetDefault'
      END,
      constraint_row.condeferrable,
      constraint_row.condeferred,
      constraint_row.convalidated
    INTO
      actual_source_schema, actual_source_table, actual_columns,
      actual_target_schema, actual_target_table, actual_target_columns,
      actual_delete_action, actual_update_action, actual_deferrable,
      actual_initially_deferred, actual_validated
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
    JOIN pg_namespace AS source_namespace
      ON source_namespace.oid = source_table.relnamespace
    JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
    JOIN pg_namespace AS target_namespace
      ON target_namespace.oid = target_table.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey)
      WITH ORDINALITY AS source_key(source_attnum, target_attnum, ordinality)
    JOIN pg_attribute AS source_attribute
      ON source_attribute.attrelid = constraint_row.conrelid
     AND source_attribute.attnum = source_key.source_attnum
    JOIN pg_attribute AS target_attribute
      ON target_attribute.attrelid = constraint_row.confrelid
     AND target_attribute.attnum = source_key.target_attnum
    WHERE constraint_row.conname = expected.constraint_name
      AND constraint_row.contype = 'f'
    GROUP BY
      constraint_row.oid, source_namespace.nspname, source_table.relname,
      target_namespace.nspname, target_table.relname;

    IF actual_source_schema IS DISTINCT FROM expected.source_schema
      OR actual_source_table IS DISTINCT FROM expected.source_table
      OR actual_columns IS DISTINCT FROM expected.source_columns::TEXT[]
      OR actual_target_schema IS DISTINCT FROM expected.target_schema
      OR actual_target_table IS DISTINCT FROM expected.target_table
      OR actual_target_columns IS DISTINCT FROM expected.target_columns::TEXT[]
      OR actual_delete_action IS DISTINCT FROM expected.delete_action
      OR actual_update_action IS DISTINCT FROM expected.update_action
      OR actual_deferrable IS DISTINCT FROM expected.is_deferrable::BOOLEAN
      OR actual_initially_deferred IS DISTINCT FROM expected.initially_deferred::BOOLEAN
      OR actual_validated IS DISTINCT FROM expected.is_validated::BOOLEAN THEN
      RAISE EXCEPTION
        'Syveka baseline incompatible foreign key %: expected %.%(%) -> %.%(%), delete %, update %, deferrable %, deferred %, validated %; found %.%(%) -> %.%(%), delete %, update %, deferrable %, deferred %, validated %',
        expected.constraint_name, expected.source_schema, expected.source_table,
        expected.source_columns, expected.target_schema, expected.target_table,
        expected.target_columns, expected.delete_action, expected.update_action,
        expected.is_deferrable, expected.initially_deferred,
        expected.is_validated, actual_source_schema, actual_source_table,
        actual_columns, actual_target_schema, actual_target_table,
        actual_target_columns, actual_delete_action, actual_update_action,
        actual_deferrable, actual_initially_deferred, actual_validated;
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

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

DO $syveka_baseline$
DECLARE
  missing_table TEXT;
  existing_table TEXT;
  baseline_tables TEXT[] := ARRAY[
    'users', 'organizations', 'organization_members', 'teams', 'invitations',
    'subscriptions', 'usage_records', 'companies', 'contacts', 'pipelines',
    'pipeline_stages', 'deals', 'activities', 'tags', 'tags_on_contacts',
    'calendar_events', 'conversations', 'messages', 'collections', 'documents',
    'document_chunks', 'prompts', 'voice_assistants', 'voice_calls', 'workflows',
    'workflow_runs', 'notifications', 'api_keys', 'webhook_endpoints', 'audit_logs'
  ];
BEGIN
  IF to_regclass('public.organizations') IS NOT NULL THEN
    SELECT table_name
    INTO missing_table
    FROM unnest(baseline_tables) AS expected(table_name)
    WHERE to_regclass(format('public.%I', table_name)) IS NULL
    LIMIT 1;

    IF missing_table IS NOT NULL THEN
      RAISE EXCEPTION
        'Syveka baseline refused an incomplete existing schema; missing public.%',
        missing_table;
    END IF;

    RETURN;
  END IF;

  SELECT table_name
  INTO existing_table
  FROM unnest(baseline_tables) AS expected(table_name)
  WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL
  LIMIT 1;

  IF existing_table IS NOT NULL THEN
    RAISE EXCEPTION
      'Syveka baseline refused a partially provisioned schema; found public.% without public.organizations',
      existing_table;
  END IF;

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('EN', 'FI', 'AR');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('PERSONAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'PAUSED');

-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM ('AI_TOKENS_IN', 'AI_TOKENS_OUT', 'AI_MESSAGES', 'VOICE_MINUTES', 'EMBEDDINGS', 'STORAGE_MB', 'WORKFLOW_RUNS', 'API_CALLS');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('LEAD', 'PROSPECT', 'CUSTOMER', 'CHURNED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('NOTE', 'TASK', 'CALL', 'EMAIL', 'MEETING', 'VOICE_AI_CALL', 'AI_SUMMARY');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('MANUAL', 'VOICE_AI', 'WORKFLOW', 'GOOGLE', 'OUTLOOK');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM', 'TOOL');

-- CreateEnum
CREATE TYPE "DocSource" AS ENUM ('UPLOAD', 'URL', 'NOTE', 'FAQ', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'NO_ANSWER', 'TRANSFERRED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'WAITING');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT,
    "avatar_url" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'FI',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Helsinki',
    "onboarded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "OrgType" NOT NULL DEFAULT 'BUSINESS',
    "logo_url" TEXT,
    "business_id" TEXT,
    "vat_id" TEXT,
    "defaultLocale" "Locale" NOT NULL DEFAULT 'FI',
    "stripe_customer_id" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "team_id" UUID,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "invited_by_id" UUID NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "stripe_subscription_id" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "status" "SubStatus" NOT NULL DEFAULT 'ACTIVE',
    "seats" INTEGER NOT NULL DEFAULT 1,
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "metric" "UsageMetric" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "business_id" TEXT,
    "industry" TEXT,
    "size" TEXT,
    "website" TEXT,
    "address" JSONB,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "company_id" UUID,
    "owner_id" UUID,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'LEAD',
    "source" TEXT,
    "locale" "Locale",
    "gdpr_consent_at" TIMESTAMP(3),
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "is_won" BOOLEAN NOT NULL DEFAULT false,
    "is_lost" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "contact_id" UUID,
    "company_id" UUID,
    "owner_id" UUID,
    "title" TEXT NOT NULL,
    "value_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "expected_close_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "contact_id" UUID,
    "deal_id" UUID,
    "type" "ActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "due_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags_on_contacts" (
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "tags_on_contacts_pkey" PRIMARY KEY ("contact_id","tag_id")
);

-- CreateTable
CREATE TABLE "calendar_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_rule" TEXT,
    "contact_id" UUID,
    "deal_id" UUID,
    "source" "EventSource" NOT NULL DEFAULT 'MANUAL',
    "external_id" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New conversation',
    "model" TEXT,
    "system_prompt_id" UUID,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "user_id" UUID,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "latency_ms" INTEGER,
    "tool_calls" JSONB,
    "citations" JSONB,
    "feedback" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "collection_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source_type" "DocSource" NOT NULL,
    "storage_path" TEXT,
    "source_url" TEXT,
    "mime_type" TEXT,
    "size_bytes" INTEGER,
    "language" "Locale",
    "status" "DocStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "created_by_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "category" TEXT NOT NULL DEFAULT 'general',
    "locale" "Locale" NOT NULL DEFAULT 'FI',
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_assistants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "vapi_assistant_id" TEXT,
    "name" TEXT NOT NULL,
    "language" "Locale" NOT NULL DEFAULT 'FI',
    "voiceProvider" TEXT NOT NULL DEFAULT 'azure',
    "voiceId" TEXT,
    "first_message" TEXT NOT NULL,
    "system_prompt" TEXT NOT NULL,
    "phone_number" TEXT,
    "enabled_tools" JSONB NOT NULL DEFAULT '[]',
    "use_knowledge_base" BOOLEAN NOT NULL DEFAULT true,
    "transfer_number" TEXT,
    "business_hours" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voice_assistants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "assistant_id" UUID NOT NULL,
    "vapi_call_id" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL DEFAULT 'INBOUND',
    "caller_number" TEXT,
    "contact_id" UUID,
    "status" "CallStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "cost_cents" INTEGER,
    "ended_reason" TEXT,
    "transcript" JSONB,
    "summary" TEXT,
    "sentiment" TEXT,
    "recording_url" TEXT,
    "actions_taken" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger_data" JSONB NOT NULL,
    "step_results" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_id" UUID,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_stripe_customer_id_key" ON "organizations"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "teams_organization_id_idx" ON "teams"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_email_key" ON "invitations"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_organization_id_key" ON "subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "usage_records_organization_id_metric_period_start_idx" ON "usage_records"("organization_id", "metric", "period_start");

-- CreateIndex
CREATE INDEX "companies_organization_id_idx" ON "companies"("organization_id");

-- CreateIndex
CREATE INDEX "contacts_organization_id_status_idx" ON "contacts"("organization_id", "status");

-- CreateIndex
CREATE INDEX "contacts_organization_id_email_idx" ON "contacts"("organization_id", "email");

-- CreateIndex
CREATE INDEX "pipelines_organization_id_idx" ON "pipelines"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_stages_pipeline_id_order_key" ON "pipeline_stages"("pipeline_id", "order");

-- CreateIndex
CREATE INDEX "deals_organization_id_stage_id_idx" ON "deals"("organization_id", "stage_id");

-- CreateIndex
CREATE INDEX "deals_organization_id_closed_at_idx" ON "deals"("organization_id", "closed_at");

-- CreateIndex
CREATE INDEX "deals_organization_id_pipeline_id_closed_at_idx" ON "deals"("organization_id", "pipeline_id", "closed_at");

-- CreateIndex
CREATE INDEX "activities_organization_id_due_at_idx" ON "activities"("organization_id", "due_at");

-- CreateIndex
CREATE INDEX "activities_organization_id_type_due_at_idx" ON "activities"("organization_id", "type", "due_at");

-- CreateIndex
CREATE INDEX "activities_organization_id_type_created_at_idx" ON "activities"("organization_id", "type", "created_at");

-- CreateIndex
CREATE INDEX "activities_contact_id_idx" ON "activities"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_organization_id_name_key" ON "tags"("organization_id", "name");

-- CreateIndex
CREATE INDEX "calendar_events_organization_id_starts_at_idx" ON "calendar_events"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_user_id_updated_at_idx" ON "conversations"("organization_id", "user_id", "updated_at");

-- CreateIndex
CREATE INDEX "conversations_organization_id_updated_at_idx" ON "conversations"("organization_id", "updated_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "collections_organization_id_idx" ON "collections"("organization_id");

-- CreateIndex
CREATE INDEX "documents_organization_id_status_idx" ON "documents"("organization_id", "status");

-- CreateIndex
CREATE INDEX "document_chunks_organization_id_idx" ON "document_chunks"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_chunks_document_id_chunk_index_key" ON "document_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "prompts_organization_id_category_idx" ON "prompts"("organization_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "voice_assistants_vapi_assistant_id_key" ON "voice_assistants"("vapi_assistant_id");

-- CreateIndex
CREATE INDEX "voice_assistants_organization_id_idx" ON "voice_assistants"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_calls_vapi_call_id_key" ON "voice_calls"("vapi_call_id");

-- CreateIndex
CREATE INDEX "voice_calls_organization_id_started_at_idx" ON "voice_calls"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "workflows_organization_id_is_active_idx" ON "workflows"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "workflow_runs_organization_id_started_at_idx" ON "workflow_runs"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_organization_id_idx" ON "api_keys"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_resource_type_resource_id_idx" ON "audit_logs"("organization_id", "resource_type", "resource_id");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags_on_contacts" ADD CONSTRAINT "tags_on_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags_on_contacts" ADD CONSTRAINT "tags_on_contacts_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assistants" ADD CONSTRAINT "voice_assistants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_assistant_id_fkey" FOREIGN KEY ("assistant_id") REFERENCES "voice_assistants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

END $syveka_baseline$;

-- A plain PostgreSQL database does not ship the Supabase roles and auth helper
-- functions used by policy DDL. Create a narrow compatibility surface only
-- when those objects are absent. Supabase-provided objects are never replaced.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::JSONB
);

DO $$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL THEN
    EXECUTE $function$
      CREATE FUNCTION auth.uid() RETURNS UUID
      LANGUAGE SQL STABLE
      AS 'SELECT nullif(current_setting(''request.jwt.claims'', true)::jsonb ->> ''sub'', '''')::uuid'
    $function$;
  END IF;

  IF to_regprocedure('auth.jwt()') IS NULL THEN
    EXECUTE $function$
      CREATE FUNCTION auth.jwt() RETURNS JSONB
      LANGUAGE SQL STABLE
      AS 'SELECT coalesce(current_setting(''request.jwt.claims'', true)::jsonb, ''{}''::jsonb)'
    $function$;
  END IF;
END $$;

GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;

CREATE OR REPLACE FUNCTION public.auth_org_id()
RETURNS UUID
LANGUAGE SQL
STABLE
AS $$ SELECT nullif(auth.jwt() ->> 'org_id', '')::UUID $$;

CREATE OR REPLACE FUNCTION public.auth_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$ SELECT auth.jwt() ->> 'role' $$;

COMMIT;
