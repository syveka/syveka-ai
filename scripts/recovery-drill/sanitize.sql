-- Recovery drill §5: neutralize everything in a restored production copy that
-- could act on the outside world or authenticate as a real user.
--
-- Runs ONLY inside the offline sanitization container (s5-sanitize-offline.sh,
-- docker --network none). One transaction: any error rolls everything back
-- and psql exits non-zero (run with -v ON_ERROR_STOP=1 --single-transaction).
--
-- Scope, from prisma/schema.prisma and docs/recovery-drill-runbook.md:
--   * the runbook's ten outbound side effects (checks 1-10 in sanitize-checks.sql);
--   * credentials the runbook does not list: API keys, calendar push-channel
--     secrets, call-recording URLs, call-transfer numbers;
--   * Supabase Auth secrets on auth.users (password hashes, one-time tokens).
-- Identities (auth.users rows, auth.identities) are kept: they are the
-- relationships the restored tenants need (public.users.id = auth.users.id).
-- Sessions, refresh tokens, MFA factors (TOTP secrets), one-time tokens, flow
-- state and SAML relay state are credentials, not relationships: they are
-- deleted here, and the sanitized auth/storage archive carries only
-- auth.users, auth.identities, storage.buckets and storage.objects anyway.

-- 1. Calendar OAuth tokens
update public.calendar_connections
set access_token_enc = null, refresh_token_enc = null, token_expires_at = null
where access_token_enc is not null or refresh_token_enc is not null or token_expires_at is not null;

-- 2. Social (Meta) tokens
update public.social_accounts
set access_token_enc = null, refresh_token_enc = null, token_expires_at = null
where access_token_enc is not null or refresh_token_enc is not null or token_expires_at is not null;

-- 3. Outbound workflow webhooks (URL + signing secret)
delete from public.webhook_endpoints;

-- 4. Active workflows
update public.workflows set is_active = false where is_active;

-- 5. Pending reminders
update public.reminders set status = 'CANCELED' where status = 'SCHEDULED';

-- 6. Scheduled or in-flight posts
update public.creator_posts
set publish_status = 'CANCELED'
where publish_status in ('SCHEDULED', 'PUBLISHING');

-- 7. Stripe ids
update public.organizations set stripe_customer_id = null where stripe_customer_id is not null;
update public.subscriptions set stripe_subscription_id = null where stripe_subscription_id is not null;

-- 8. Vapi assistants and numbers (plus the transfer number, check 14)
update public.voice_assistants
set vapi_assistant_id = null, phone_number = null, transfer_number = null, is_active = false
where vapi_assistant_id is not null or phone_number is not null or transfer_number is not null or is_active;

-- 9. Open invitations
update public.invitations set status = 'EXPIRED' where status = 'PENDING';

-- 10. Live booking tokens
update public.booking_tokens
set expires_at = now() - interval '1 second'
where used_at is null and expires_at > now();

-- 11. API keys (only hashes are stored, but a production key must not work here)
update public.api_keys set revoked_at = now() where revoked_at is null;

-- 12. Calendar push channels and their verification secret hashes
update public.calendar_sync_states
set webhook_subscription_id = null, webhook_resource_id = null,
    webhook_expires_at = null, webhook_verification_secret_hash = null
where webhook_subscription_id is not null or webhook_resource_id is not null
   or webhook_expires_at is not null or webhook_verification_secret_hash is not null;

-- 13. Call-recording URLs (provider-hosted audio)
update public.voice_calls set recording_url = null where recording_url is not null;

-- 16-23. Auth sessions and token tables, children first (each only if this
-- Auth version has it).
do $delete_auth_tokens$
declare
  token_table text;
begin
  foreach token_table in array array[
    'mfa_amr_claims', 'refresh_tokens', 'sessions', 'mfa_challenges',
    'mfa_factors', 'one_time_tokens', 'flow_state', 'saml_relay_states'
  ] loop
    if to_regclass(format('auth.%I', token_table)) is not null then
      execute format('delete from auth.%I', token_table);
    end if;
  end loop;
end
$delete_auth_tokens$;

-- 15. Supabase Auth secrets on auth.users. The column set depends on the Auth
-- version, so only the listed columns that exist are touched; the checks fail
-- if encrypted_password itself is absent. Empty string, not NULL: older Auth
-- versions scan these columns into non-nullable strings.
do $sanitize_auth_users$
declare
  secret_column text;
begin
  foreach secret_column in array array[
    'encrypted_password', 'confirmation_token', 'recovery_token',
    'email_change_token_new', 'email_change_token_current',
    'phone_change_token', 'reauthentication_token'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = secret_column
    ) then
      execute format(
        'update auth.users set %1$I = %2$L where coalesce(%1$I::text, %2$L) <> %2$L',
        secret_column, ''
      );
    end if;
  end loop;
end
$sanitize_auth_users$;
