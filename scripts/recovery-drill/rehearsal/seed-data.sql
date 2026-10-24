-- SYNTHETIC REHEARSAL ONLY. Production-shaped fake data: one tenant with a
-- value in every column the drill must neutralize. Every value sanitization
-- must remove contains the marker SYNTHETIC-SECRET, so a plain-text scan of
-- an archive shows whether any survived. Addresses use the reserved .invalid
-- domain. Run as postgres after the 31 production migrations.

insert into auth.users (id, email, encrypted_password, confirmation_token, recovery_token, raw_user_meta_data)
values
  ('a0000000-0000-4000-8000-0000000000a1', 'owner-a@drill.invalid',
   '$2a$10$SYNTHETIC-SECRET-password-hash-a', 'SYNTHETIC-SECRET-confirm-a',
   'SYNTHETIC-SECRET-recovery-a', '{"full_name": "Synthetic Owner A"}'),
  ('b0000000-0000-4000-8000-0000000000b1', 'member-b@drill.invalid',
   '$2a$10$SYNTHETIC-SECRET-password-hash-b', '', '', '{}');

insert into auth.identities (provider_id, user_id, identity_data, provider)
values
  ('a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1',
   '{"sub": "a0000000-0000-4000-8000-0000000000a1", "email": "owner-a@drill.invalid"}', 'email'),
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-0000000000b1',
   '{"sub": "b0000000-0000-4000-8000-0000000000b1", "email": "member-b@drill.invalid"}', 'email');

insert into auth.sessions (id, user_id) values
  ('a1000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1');
insert into auth.refresh_tokens (token, user_id, revoked) values
  ('SYNTHETIC-SECRET-refresh-a', 'a0000000-0000-4000-8000-0000000000a1', false);
insert into auth.mfa_factors (id, user_id, factor_type, secret) values
  ('a2000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'totp', 'SYNTHETIC-SECRET-totp-a');
insert into auth.mfa_challenges (id, factor_id) values
  ('a3000000-0000-4000-8000-0000000000a1', 'a2000000-0000-4000-8000-0000000000a1');
insert into auth.mfa_amr_claims (id, session_id, authentication_method) values
  ('a4000000-0000-4000-8000-0000000000a1', 'a1000000-0000-4000-8000-0000000000a1', 'password');
insert into auth.one_time_tokens (id, user_id, token_type, token_hash) values
  ('a5000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'recovery', 'SYNTHETIC-SECRET-ott-a');
insert into auth.flow_state (id, user_id, auth_code, provider_access_token, provider_refresh_token) values
  ('a6000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1',
   'SYNTHETIC-SECRET-code-a', 'SYNTHETIC-SECRET-provider-access-a', 'SYNTHETIC-SECRET-provider-refresh-a');

insert into storage.buckets (id, name, public) values ('documents', 'documents', false);
insert into storage.objects (bucket_id, name, metadata) values
  ('documents', '11111111-0000-4000-8000-0000000000a1/synthetic/report.pdf', '{"size": 1024}');

insert into organizations (id, name, slug, stripe_customer_id, created_at, updated_at) values
  ('11111111-0000-4000-8000-0000000000a1', 'Synthetic Org A', 'synthetic-org-a', 'cus_SYNTHETIC-SECRET-a', now(), now());
insert into organization_members (organization_id, user_id, role) values
  ('11111111-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'OWNER'),
  ('11111111-0000-4000-8000-0000000000a1', 'b0000000-0000-4000-8000-0000000000b1', 'MEMBER');
insert into subscriptions (organization_id, stripe_subscription_id, updated_at) values
  ('11111111-0000-4000-8000-0000000000a1', 'sub_SYNTHETIC-SECRET-a', now());

insert into calendar_connections (id, organization_id, user_id, provider, account_email,
  access_token_enc, refresh_token_enc, token_expires_at, updated_at) values
  ('c1000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'a0000000-0000-4000-8000-0000000000a1', 'MOCK', 'owner-a@drill.invalid',
   'SYNTHETIC-SECRET-calendar-access', 'SYNTHETIC-SECRET-calendar-refresh', now() + interval '1 hour', now());
insert into external_calendars (id, connection_id, organization_id, external_id, name) values
  ('c2000000-0000-4000-8000-0000000000a1', 'c1000000-0000-4000-8000-0000000000a1',
   '11111111-0000-4000-8000-0000000000a1', 'external-a', 'Calendar A');
insert into calendar_sync_states (id, organization_id, external_calendar_id, webhook_subscription_id,
  webhook_resource_id, webhook_expires_at, webhook_verification_secret_hash, updated_at) values
  ('c3000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'c2000000-0000-4000-8000-0000000000a1', 'SYNTHETIC-SECRET-channel', 'SYNTHETIC-SECRET-resource',
   now() + interval '1 day', 'SYNTHETIC-SECRET-channel-hash', now());

insert into social_accounts (id, organization_id, platform, external_account_id, display_name,
  access_token_enc, refresh_token_enc, token_expires_at, updated_at) values
  ('d1000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1', 'INSTAGRAM',
   'ig-synthetic-a', 'Synthetic IG', 'SYNTHETIC-SECRET-meta-access', 'SYNTHETIC-SECRET-meta-refresh',
   now() + interval '1 day', now());
insert into creator_posts (id, organization_id, platform, social_account_id, publish_status,
  scheduled_for, created_by_id, updated_at) values
  ('d2000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1', 'INSTAGRAM',
   'd1000000-0000-4000-8000-0000000000a1', 'SCHEDULED', now() + interval '1 day',
   'a0000000-0000-4000-8000-0000000000a1', now()),
  ('d2000000-0000-4000-8000-0000000000a2', '11111111-0000-4000-8000-0000000000a1', 'INSTAGRAM',
   'd1000000-0000-4000-8000-0000000000a1', 'PUBLISHING', now(),
   'a0000000-0000-4000-8000-0000000000a1', now());

insert into webhook_endpoints (organization_id, url, secret) values
  ('11111111-0000-4000-8000-0000000000a1', 'https://SYNTHETIC-SECRET.invalid/hook', 'SYNTHETIC-SECRET-whsec');
insert into workflows (organization_id, created_by_id, name, trigger, steps, is_active, updated_at) values
  ('11111111-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'Synthetic workflow',
   '{"type": "contact.created"}', '[]', true, now());
insert into reminders (organization_id, send_at, status, dedupe_key) values
  ('11111111-0000-4000-8000-0000000000a1', now() + interval '1 day', 'SCHEDULED', 'synthetic-reminder-a');

insert into voice_assistants (id, organization_id, vapi_assistant_id, name, first_message, system_prompt,
  phone_number, transfer_number, is_active, updated_at) values
  ('e1000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1', 'SYNTHETIC-SECRET-vapi',
   'Synthetic assistant', 'Hello', 'Synthetic prompt', '+358000SYNTHETIC-SECRET', '+358001SYNTHETIC-SECRET', true, now());
insert into voice_calls (organization_id, assistant_id, vapi_call_id, started_at, recording_url) values
  ('11111111-0000-4000-8000-0000000000a1', 'e1000000-0000-4000-8000-0000000000a1', 'synthetic-call-a', now(),
   'https://SYNTHETIC-SECRET.invalid/recording.wav');

insert into invitations (organization_id, email, invited_by_id, status, expires_at) values
  ('11111111-0000-4000-8000-0000000000a1', 'invitee@drill.invalid', 'a0000000-0000-4000-8000-0000000000a1',
   'PENDING', now() + interval '7 days');
insert into api_keys (organization_id, name, key_hash, prefix) values
  ('11111111-0000-4000-8000-0000000000a1', 'Synthetic key', 'synthetic-key-hash-a', 'sk_syn');

insert into availability_schedules (id, organization_id, user_id, name, updated_at) values
  ('f1000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'a0000000-0000-4000-8000-0000000000a1', 'Availability A', now());
insert into booking_types (id, organization_id, owner_id, schedule_id, slug, name, updated_at) values
  ('f2000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'a0000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1', 'booking-a', 'Booking A', now());
insert into calendar_events (id, organization_id, created_by_id, title, starts_at, ends_at, updated_at) values
  ('f3000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'a0000000-0000-4000-8000-0000000000a1', 'Event A', now() + interval '2 days',
   now() + interval '2 days 30 minutes', now());
insert into bookings (id, organization_id, booking_type_id, event_id, guest_name, guest_email,
  starts_at, ends_at, updated_at) values
  ('f4000000-0000-4000-8000-0000000000a1', '11111111-0000-4000-8000-0000000000a1',
   'f2000000-0000-4000-8000-0000000000a1', 'f3000000-0000-4000-8000-0000000000a1', 'Guest A',
   'guest-a@drill.invalid', now() + interval '2 days', now() + interval '2 days 30 minutes', now());
insert into booking_tokens (booking_id, token_hash, purpose, expires_at) values
  ('f4000000-0000-4000-8000-0000000000a1', 'synthetic-booking-token-hash-a', 'MANAGE', now() + interval '1 day');
