-- Recovery drill §5/§6: forbidden-data counts. Counts only, never row contents.
--
-- Output: one line per check, `check|<name>|<value>` (psql -X -At -F '|').
-- validate_checks in lib.sh compares the output with expected-checks.txt:
-- every expected check must appear exactly once with value 0 (or ABSENT where
-- the check allows it); a missing, duplicated, unknown or non-zero check fails.
-- Run with -v ON_ERROR_STOP=1: a missing application table is a SQL error,
-- which also fails. Read-only apart from session-local pg_temp helpers.
-- Requires scrub-functions.sql loaded first in the same session (the JSON and
-- text checks use the scrubber's own detection functions).

create function pg_temp.drill_count_rows(schema_name text, table_name text)
returns text language plpgsql as $$
declare
  row_count bigint;
begin
  if to_regclass(format('%I.%I', schema_name, table_name)) is null then
    return 'ABSENT';
  end if;
  execute format('select count(*) from %I.%I', schema_name, table_name) into row_count;
  return row_count::text;
end
$$;

-- Rows of auth.users that still hold any secret column (only the columns that
-- exist in this Auth version). MISSING_COLUMN if encrypted_password is absent,
-- which validate_checks treats as a failure.
create function pg_temp.drill_auth_user_secrets()
returns text language plpgsql as $$
declare
  predicate text;
  row_count bigint;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password'
  ) then
    return 'MISSING_COLUMN';
  end if;
  select string_agg(format('coalesce(%I::text, %L) <> %L', column_name, '', ''), ' or ')
  into predicate
  from information_schema.columns
  where table_schema = 'auth' and table_name = 'users'
    and column_name in (
      'encrypted_password', 'confirmation_token', 'recovery_token',
      'email_change_token_new', 'email_change_token_current',
      'phone_change_token', 'reauthentication_token'
    );
  execute 'select count(*) from auth.users where ' || predicate into row_count;
  return row_count::text;
end
$$;

-- Auth tables outside the known set that contain rows: catches session- or
-- token-bearing tables added by a newer Auth version.
create function pg_temp.drill_auth_unlisted_tables_with_rows()
returns text language plpgsql as $$
declare
  auth_table record;
  has_rows boolean;
  tables_with_rows integer := 0;
begin
  for auth_table in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relkind in ('r', 'p')
      and c.relname not in (
        'users', 'identities', 'instances', 'schema_migrations',
        'sessions', 'refresh_tokens', 'mfa_factors', 'mfa_challenges',
        'mfa_amr_claims', 'one_time_tokens', 'flow_state', 'saml_relay_states',
        'saml_providers', 'sso_providers', 'sso_domains', 'audit_log_entries'
      )
  loop
    execute format('select exists (select 1 from auth.%I)', auth_table.relname) into has_rows;
    if has_rows then
      tables_with_rows := tables_with_rows + 1;
    end if;
  end loop;
  return tables_with_rows::text;
end
$$;

select 'check', 'calendar_oauth_tokens', count(*)::text
from public.calendar_connections where access_token_enc is not null or refresh_token_enc is not null
union all
select 'check', 'social_tokens', count(*)::text
from public.social_accounts where access_token_enc is not null or refresh_token_enc is not null
union all
select 'check', 'webhook_endpoints', count(*)::text from public.webhook_endpoints
union all
select 'check', 'active_workflows', count(*)::text from public.workflows where is_active
union all
select 'check', 'pending_reminders', count(*)::text from public.reminders where status = 'SCHEDULED'
union all
select 'check', 'scheduled_or_inflight_posts', count(*)::text
from public.creator_posts where publish_status in ('SCHEDULED', 'PUBLISHING')
union all
select 'check', 'stripe_ids',
  ((select count(*) from public.organizations where stripe_customer_id is not null)
   + (select count(*) from public.subscriptions where stripe_subscription_id is not null))::text
union all
select 'check', 'vapi_assistants_and_numbers', count(*)::text
from public.voice_assistants where vapi_assistant_id is not null or phone_number is not null or is_active
union all
select 'check', 'open_invitations', count(*)::text from public.invitations where status = 'PENDING'
union all
select 'check', 'live_booking_tokens', count(*)::text
from public.booking_tokens where used_at is null and expires_at > now()
union all
select 'check', 'active_api_keys', count(*)::text from public.api_keys where revoked_at is null
union all
select 'check', 'calendar_push_channels', count(*)::text
from public.calendar_sync_states
where webhook_subscription_id is not null or webhook_resource_id is not null
   or webhook_expires_at is not null or webhook_verification_secret_hash is not null
union all
select 'check', 'voice_recording_urls', count(*)::text from public.voice_calls where recording_url is not null
union all
select 'check', 'voice_transfer_numbers', count(*)::text
from public.voice_assistants where transfer_number is not null
union all
select 'check', 'integration_error_texts',
  ((select count(*) from public.calendar_connections where last_error is not null)
   + (select count(*) from public.social_accounts where last_error is not null))::text
union all
select 'check', 'workflow_email_recipients', count(*)::text
from public.workflows
where jsonb_path_exists(steps::jsonb, 'lax $.** ? (@.type == "email.send" && @.to != "redacted@drill.invalid")')
   or jsonb_path_exists(trigger::jsonb, 'lax $.** ? (@.type == "email.send" && @.to != "redacted@drill.invalid")')
union all
select 'check', 'json_sensitive_values', pg_temp.drill_count_sensitive('json')::text
union all
select 'check', 'text_secret_patterns', pg_temp.drill_count_sensitive('text')::text
union all
select 'check', 'auth_user_secrets', pg_temp.drill_auth_user_secrets()
union all
select 'check', 'auth_sessions', pg_temp.drill_count_rows('auth', 'sessions')
union all
select 'check', 'auth_refresh_tokens', pg_temp.drill_count_rows('auth', 'refresh_tokens')
union all
select 'check', 'auth_mfa_factors', pg_temp.drill_count_rows('auth', 'mfa_factors')
union all
select 'check', 'auth_mfa_challenges', pg_temp.drill_count_rows('auth', 'mfa_challenges')
union all
select 'check', 'auth_mfa_amr_claims', pg_temp.drill_count_rows('auth', 'mfa_amr_claims')
union all
select 'check', 'auth_one_time_tokens', pg_temp.drill_count_rows('auth', 'one_time_tokens')
union all
select 'check', 'auth_flow_state', pg_temp.drill_count_rows('auth', 'flow_state')
union all
select 'check', 'auth_saml_relay_states', pg_temp.drill_count_rows('auth', 'saml_relay_states')
union all
select 'check', 'auth_unlisted_tables_with_rows', pg_temp.drill_auth_unlisted_tables_with_rows();
