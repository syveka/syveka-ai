# CRM Calendar & Booking Assistant V1

Branch: `feature/calendar-booking-v1` · Status: ready for review · Do not deploy without the manual setup below.

## Architecture overview

The module extends the existing `CalendarEvent` model (no duplicate models) and adds a booking domain on top of three layers:

1. **Pure domain logic** — `src/server/calendar/`
   - `timezone.ts`: Intl-based timezone math (no new dependencies). Wall-clock ↔ UTC conversion with deterministic DST handling.
   - `recurrence.ts`: RFC 5545 RRULE subset (`FREQ=DAILY|WEEKLY|MONTHLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`) with typed validation errors and capped expansion.
   - `slots.ts`: availability computation — weekly rules, date overrides, buffers, minimum notice, maximum booking window, busy-interval conflict filtering. All slot math happens in the schedule's timezone.
2. **Services** — `src/server/services/`
   - `calendar.ts`: event CRUD (attendees, CRM links, owner, soft cancel/delete), conflict detection (recurring-aware), entity timelines, dashboard feed. All access via `tenantDb(orgId)`; every linked contact/company/deal/owner is re-resolved inside the tenant (cross-tenant relationship rejection).
   - `availability.ts`: schedule/rule/override management (single default per user, overlap validation).
   - `booking.ts`: booking types (public pages), public slot computation, guest booking with **double-booking protection** (availability check → owner-calendar `pg_advisory_xact_lock` → re-check inside `$transaction` before insert - the lock is load-bearing: a bare re-check inside a transaction does _not_ prevent two concurrent guests from both committing under Postgres's default READ COMMITTED isolation, see `lockOwnerCalendar()`'s comment in `src/server/calendar/locks.ts` and `tests/integration/booking-concurrency.sh` for a real-Postgres proof), token-based cancel/reschedule (reschedule creates a linked successor booking).
   - `booking-tokens.ts`: 256-bit single-purpose expiring tokens, SHA-256 hashed at rest, constant-time comparison; `MANAGE` covers cancel+reschedule.
   - `reminders.ts` + `/api/v1/jobs/send-reminder`: Reminder rows (unique `dedupeKey`) + delayed QStash jobs; the job claims the row with a guarded `updateMany` (SCHEDULED→SENT) so retries can never double-send.
   - `booking-notifications.ts`: guest + owner emails (Resend, localized en/fi/ar template `emails/booking-email.tsx`) and in-app notifications, guarded by Redis idempotency keys.
   - `booking-assistant.ts`: AI layer on the existing model router. The model never decides availability — it ranks/explains slots computed deterministically; every AI call has a non-AI fallback.
   - `calendar-connections.ts` / `calendar-sync.ts`: external provider connection lifecycle + idempotent incremental sync (below).
3. **Transport** — server actions (`src/actions/{calendar,availability,booking-types,calendar-integrations}.ts`, all behind `requirePermission`) and public API routes (`/api/v1/booking/*`, rate-limited).

### External calendar integration architecture

`src/server/integrations/calendar/` defines a `CalendarProviderAdapter` interface (`types.ts`) with three implementations:

- `google.ts` — Google Calendar REST (OAuth code flow, `syncToken` incremental sync, `events.watch` webhook channels; 410 → cursor reset).
- `microsoft.ts` — Microsoft Graph (OAuth code flow, `calendarView/delta` incremental sync, Graph change-notification subscriptions incl. `validationToken` handshake).
- `mock.ts` — deterministic in-memory provider used in tests and credential-less environments (`CALENDAR_MOCK_PROVIDER=1` or non-production).

OAuth tokens are stored AES-256-GCM-encrypted (`crypto.ts`); refresh happens lazily 2 minutes before expiry; failures flip the connection to `NEEDS_REAUTH` with a visible health status and reconnect flow. Disconnect best-effort revokes tokens + webhook subscriptions, then purges secrets locally (imported events are kept as history).

**Sync strategy** (`calendar-sync.ts`): pull-based incremental sync keyed by a per-calendar cursor (`CalendarSyncState`). Events upsert on the unique `(externalCalendarId, externalId)` pair — replaying a page is a no-op, making the sync idempotent. Cursors persist only after a page is fully applied. Remote deletions become local cancellations; locally deleted events keep their tombstone (conflict rule: local delete wins). Webhook pings (`/api/v1/webhooks/calendar/[provider]`) only trigger a sync for the matching subscription — payloads are never trusted as data.

## Database

Schema migration: `prisma/migrations/20260713000000_calendar_booking_v1/migration.sql` (idempotent SQL, follows repo convention).
RLS migration: `prisma/migrations/20260718000000_calendar_booking_rls/migration.sql`.

- Extended: `calendar_events` (+ owner, timezone, status, company/deal linkage indexes, external sync linkage, soft delete).
- New: `event_attendees`, `calendar_connections`, `external_calendars`, `calendar_sync_states`, `availability_schedules`, `availability_rules`, `availability_overrides`, `booking_types`, `bookings`, `booking_tokens`, `reminders`.
- **Index ownership**: every index on the tables above is created and owned by the schema migration.
- **RLS ownership**: the additive `20260718000000_calendar_booking_rls` Prisma migration enables RLS and owns the authenticated read policies. `prisma/sql/005_calendar_booking_rls.sql` is a deprecated compatibility wrapper and is not a separate deployment step.
- `tenantDb` scoping: new org-owned models added to `TENANT_MODELS`; `EventAttendee`, `AvailabilityRule`, `AvailabilityOverride`, `BookingToken` are parent-scoped (accessed only through verified parents).

## RBAC & security

New permissions: `calendar:delete`, `booking:manage`, `integrations:manage` (plus existing `calendar:read/write`). Matrix: OWNER/ADMIN all; MANAGER adds `booking:manage`; MEMBER has calendar read/write/delete; VIEWER read-only. All server actions call `requirePermission`; `integrations:*` denials are audit-logged.

- Tenant isolation via `tenantDb` + in-tenant re-resolution of every foreign key from user input.
- Public booking abuse prevention: per-IP rate limits (slots: api-tier, booking/cancel/reschedule: strict auth-tier), Zod validation, honeypot field, consent enforcement, ≤62-day slot query windows.
- Tokens: hashed at rest, expiring (30 d), single-use for CANCEL/RESCHEDULE, invalidated in bulk on state changes; management endpoints rate-limited against brute force.
- OAuth `state` is HMAC-signed, tenant-bound and expires in 10 minutes; secrets (encrypted tokens, booking tokens, reminders, sync state) have **no client RLS policies** — server-only. No secrets are ever serialized to the client.
- Audit log entries for event CRUD, availability changes, booking lifecycle, connect/disconnect/sync toggles.

### Membership removal and calendar access

This closes R1, a residual tenant-isolation finding from the earlier auth and tenant-isolation
audit. Once a membership removal commits, that member's calendar connection in that organization
imports nothing more, and in-flight work persists nothing after the removal.

- **Removal** (`removeMember`, `src/server/services/members.ts`): one transaction deletes the
  membership and then, for that user in that organization only:
  - sets their `calendar_connections` to `DISCONNECTED` and nulls the access token, refresh token
    and expiry (`lastError = membership_removed`);
  - turns sync off on their calendars, and deletes their sync state, which holds the cursor and the
    webhook secret hash, so webhook pings fail verification.
- **What removal does and doesn't change:**
  - Connections in other organizations, and other members' connections, are untouched.
  - **Only local credentials are removed. Nothing is revoked at the provider:** the grant is the
    user's own and may serve their other organizations. Provider webhook channels lapse on their
    own; their pings no longer verify.
- **Every write on the user's behalf is guarded:**
  - OAuth connection persistence (after the token exchange);
  - refreshed tokens;
  - each imported page (events, deletions, cursor);
  - webhook subscription state.

  Each runs in a transaction that first takes `lockCalendarMember()`
  (`src/server/calendar/locks.ts`), which locks the membership and organization rows with
  `FOR SHARE OF m, o`. Sync and refresh also take `lockActiveCalendarConnection()` (`FOR SHARE`,
  or `FOR UPDATE` for refresh). Under READ COMMITTED:
  - **The writer locks first:** the removal's `DELETE` waits. The invalidation that follows it
    then clears what the writer committed.
  - **The removal reached the row first:** the writer waits, re-reads, finds no row, and writes
    nothing.
  - **Organization soft-delete:** an `UPDATE` of the organization row conflicts the same way, and
    a deleted organization yields no row.
  - **No deadlocks:** lock order is always membership or organization, then connection, matching
    the removal's `DELETE`-then-`UPDATE` order.
  - **No transaction during network calls:** provider calls (token exchange, calendar listing,
    refresh, event fetch, subscribe) run before the transaction.

- **Stale refresh:** refreshed tokens are stored only if the refresh token used is still the stored
  one (a compare-and-swap on its ciphertext), so a stale refresh can't restore credentials or
  overwrite a later re-connection. `markConnectionStatus()` never overwrites `DISCONNECTED`.
- **Members removed before this change:** their connections were not invalidated. Token reads,
  sync and subscription renewal refuse them (`getFreshTokens` checks membership, so sync stops
  before any provider fetch), and no live data is changed retroactively. Their
  encrypted tokens remain stored until the connections are cleaned up, which is an owner decision.
- **Evidence:**
  - `tests/unit/calendar-membership-revocation.test.ts` covers this with mocked provider
    sequencing: removal during the OAuth exchange, after a sync fetch, during a refresh;
    re-connection; webhooks and retries; cross-organization isolation; soft-deleted organizations.
    Its 12 revocation cases fail against the previous implementation.
  - `tests/integration/calendar-membership-race-concurrency.sh` proves the Postgres lock semantics
    on a scratch database. It's manual and not run in CI.

**Already imported events (unchanged; still an open product decision):**

- **Imported events stay.** Events imported before the removal remain in the organization's
  calendar, with title, description, location and up to 50 attendees. They're owned by the former
  member and visible wherever organization events are listed. This matches the existing behavior
  of a voluntary disconnect ("imported events stay as the record of past meetings"). No new events
  are added and existing ones aren't updated.
- **The open options:** keep them (current), or delete or anonymize them on removal. The rows have
  `source` `GOOGLE` or `OUTLOOK`, and their `externalCalendarId` belongs to the invalidated
  connection; deleting them loses the organization's record of those meetings. Neither is
  automatic.

### Public booking links of removed members

Product decision: when a member is removed, their public booking types stop accepting new
bookings. Existing bookings and imported events are unchanged. Types are not reassigned, and
rejoining doesn't reactivate them.

- **Removal** (`removeMember`): in the same transaction, after the membership `DELETE`, the member's
  booking types in that organization are set to `isActive = false`. Other members' types, and the
  same user's types in other organizations, are untouched. Nothing else changes: no booking,
  calendar event, external calendar or guest message.
- **Server-side eligibility.** `getPublicBookingType()` resolves a type only if it is active, not
  deleted, in a non-deleted organization, **and** its owner is a current member. That lookup backs:
  - the public page;
  - the slots API;
  - booking creation;
  - rescheduling.

  Anything else gets the same generic not-found response as an unknown link, so membership isn't
  revealed. The owner check also blocks types whose owner was removed **before** this change. No
  live backfill was run; their rows stay `isActive = true` until an admin edits them.

- **Inside each booking-creating transaction** (`createPublicBooking`, and
  `rescheduleBookingViaToken`, which creates a successor booking), before the existing slot lock or
  any write: `lockCalendarMember()` takes `FOR SHARE OF` the membership and organization rows, then
  `lockBookableBookingType()` takes `FOR SHARE` on the booking type, which must still be active.
  Canceling an existing booking is unaffected.
- **Ordering against a concurrent removal** (READ COMMITTED):
  - **The booking holds the locks first:** the removal's `DELETE` waits; the booking commits, and
    then the type is disabled.
  - **The removal got there first:** the booking waits, then finds no membership row and books
    nothing.
  - **Organization soft-delete:** an `UPDATE` of the organization row conflicts with the
    `FOR SHARE` on it the same way.
- **Lock order:** membership and organization rows, then the booking type, the same order as the
  removal (membership `DELETE`, then booking type `UPDATE`, then calendar connections).
  - **Reversing it deadlocks.** The integration script shows that the reversed order (booking type,
    then membership) deadlocks under the same timing, and Postgres aborts one transaction with
    `40P01`. This is why the order matters.
  - **Not every deadlock is ruled out.** This ordering removes that cycle, but other transactions
    touching these rows could still form a cycle. If Postgres aborts one, the transaction rolls
    back completely. A guest gets the existing generic failure response and can retry; a removal
    returns an error to the admin and can be retried.
- **Reactivation:** `saveBookingType()` refuses to save a type as active while its owner isn't a
  current member (`owner_not_member`, shown in the booking-type form in EN/FI/AR). After the owner
  rejoins, an admin with `booking:manage` can turn it back on explicitly. Saving it inactive is
  always allowed.
- **Evidence:**
  - `tests/unit/booking-owner-removal.test.ts` (mocked sequencing). Its regression cases fail on the
    previous implementation.
  - `tests/integration/booking-owner-removal-race-concurrency.sh`: real Postgres, manual, not in
    CI. Scenarios: booking first, removal first, the unfixed race, the reversed-order deadlock, and
    no deadlock with the code's order.

**Remaining limitations:**

- **Calendar view:** a removed owner's existing future bookings still appear on the organization's
  calendar, and guests can still cancel them through their links.
- **Ownership:** the booking types themselves stay owned by the former member, because nothing
  reassigns them.

## Environment variables

```
CALENDAR_TOKEN_ENCRYPTION_KEY   # required for real providers; openssl rand -base64 32
CALENDAR_OAUTH_STATE_SECRET     # optional; falls back to QSTASH_CURRENT_SIGNING_KEY
CALENDAR_MOCK_PROVIDER          # "1" to expose the mock provider outside dev
GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET
MICROSOFT_CALENDAR_CLIENT_ID / MICROSOFT_CALENDAR_CLIENT_SECRET / MICROSOFT_CALENDAR_TENANT
```

### Provider setup / OAuth callback configuration

- **Google**: create an OAuth client (Web) in Google Cloud Console with Calendar API enabled. Authorized redirect URI: `{NEXT_PUBLIC_APP_URL}/api/v1/integrations/calendar/google/callback`. Scopes requested: `calendar.readonly`, `calendar.events`, `openid`, `email`. Webhook channels require the app URL to be publicly reachable over HTTPS.
- **Microsoft**: register an app in Entra ID (multi-tenant or your tenant). Redirect URI (Web): `{NEXT_PUBLIC_APP_URL}/api/v1/integrations/calendar/microsoft/callback`. Delegated permissions: `Calendars.ReadWrite`, `offline_access`, `openid`, `email`. Graph subscriptions expire after ~3 days; re-subscription happens on sync (`ensureWebhookSubscription`) — schedule a periodic `calendar-sync` job for long-lived renewals.
- **Without credentials**: the settings UI shows the provider as "Not configured"; the MOCK provider exercises the full connect → select calendars → sync pipeline.

## UI & localization

Calendar page (`/calendar`): day/week/month/agenda views, search, assistant panel, event dialog (timezone, recurrence presets, all-day, owner, contact/company/deal links, attendees, conflict warning with explicit override). `/calendar/availability` (schedules), `/calendar/booking-types` (public pages incl. copy-link), `/settings/integrations` (connections). Public: `/book/[org]/[slug]` and `/booking/manage/[token]`. Everything uses the existing design system, `next-intl` messages (full en/fi/ar parity, RTL-safe via logical properties `ms-/me-/start/end`), locale-aware `Intl` date/time formatting, and dark-mode tokens. No hardcoded user-facing strings.

## Testing

`tests/unit/`: `calendar-timezone` (DST spring-forward/fall-back, day iteration), `calendar-recurrence` (validation + expansion incl. short-month skips), `calendar-slots` (availability, buffers, min-notice, max-window, conflicts, DST slot grid), `calendar-rbac`, `calendar-crypto`, `booking-validators` (honeypot, consent, slugs), `booking-tokens` (hashing, expiry, purpose, single-use), `calendar-service` (tenant scoping, cross-tenant rejection, conflicts incl. recurring), `booking-service` (double-booking race inside transaction, consent, contact matching), `calendar-sync` (idempotent replay, etag skip, tombstone conflict, deletions, cursor reset).

## Known limitations

- Outbound sync (pushing Syveka events to Google/Microsoft) is not in V1 — import-only sync; the abstraction has the write surface reserved.
- Recurring events support a pragmatic RRULE subset; exotic rules from external calendars sync as expanded single instances.
- Reschedule uses the original meeting duration; duration changes require cancel + rebook.
- Booking "completed" activity records are not automated (no post-meeting job yet).
- Graph/Google webhook channels need public HTTPS; in dev use "Sync now".
- Reminder offsets are fixed (24 h, 1 h) in V1.

## Manual QA checklist

1. Create/edit/cancel/delete events in each view (day/week/month/agenda), incl. all-day and weekly recurring; verify conflict warning + override.
2. Link an event to a contact, company and deal; confirm it appears on all three CRM timelines and the dashboard widget.
3. Configure availability (rules + an unavailable override) and confirm `/book/...` hides those times; verify times render in the guest's browser timezone.
4. Book as a guest (with consent), verify confirmation email + owner notification + CRM activity. Manually clicking "book" in two sequential tabs does **not** exercise the real double-booking race (the first request finishes and commits well before you click the second) - it only proves the plain re-check guard works, not the concurrency-safety property. For that, run `tests/integration/booking-concurrency.sh` against a scratch Postgres, which fires two genuinely concurrent transactions and proves both that the race exists without the advisory lock and that the lock closes it.
5. Use the manage link: reschedule, then cancel; verify emails, token expiry after use, and 404 on reuse.
6. Connect the MOCK provider, enable sync on a calendar, run "Sync now" twice — no duplicates; disconnect and verify status.
7. Switch locale to Finnish and Arabic (RTL): all calendar/booking screens fully translated and mirrored; dark mode intact.
8. As VIEWER: no write buttons; direct action calls rejected (403).
