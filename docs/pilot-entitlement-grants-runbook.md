# Pilot entitlement grants runbook (as of main `6339063`)

How to give a free-pilot organization only what it needs, using the entitlement grant mechanism
that already exists. Everything here is read from the code; nothing in this document was executed
against staging or production. Where a step needs live verification, it says so.

## 1. What a new organization gets by default

Every organization is created with `Subscription { plan: FREE, status: ACTIVE, seats: 1 }`
(`src/server/services/organizations.ts`). The FREE limits (`src/lib/billing/plan-catalog.ts`):

| Limit                            | FREE  | Where it is enforced                                                        |
| -------------------------------- | ----- | --------------------------------------------------------------------------- |
| `maxSeats`                       | 2     | inviting (members + pending invitations) and accepting an invitation        |
| `aiMessagesPerOrgMonth` (pooled) | 50    | AI chat, inbox drafts, deal insights, calendar assistant, workflow AI steps |
| `maxContacts`                    | 200   | creating a CRM contact (companies and deals are not counted)                |
| `kbStorageMb`                    | 50    | knowledge-base uploads                                                      |
| `activeWorkflows`                | 0     | activating or test-running a workflow (so Workflows are OFF on FREE)        |
| `voiceAssistants`                | 0     | creating or opening a voice assistant (so Voice is OFF on FREE)             |
| `voiceMinutesMonth`              | 0     | voice minutes                                                               |
| `creatorCreditsPerMonth`         | 0     | Creator Studio credits (Creator Studio itself is behind a separate flag)    |
| `auditRetentionDays`             | 0     | display only; nothing purges audit rows by it                               |
| `apiAccess`                      | false | not grantable                                                               |

The effective limit is `plan limit + sum(active grants)` per metric
(`src/server/services/billing/entitlements.ts`). Results are cached in Redis for 60 seconds, so a
grant takes up to a minute to apply.

**Consequence for the pilot scope:** Business DNA, AI chat, CRM, booking/calendar and invitations
all work on FREE with no grant at all. Grants only raise the four numeric limits a real business
will hit: seats, AI messages, contacts, knowledge storage.

## 2. What is NOT controlled by entitlements

| Feature                       | How it is actually gated                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Creator Studio                | `Organization.settings.creator_studio_v1 === true` (`src/server/services/feature-flags.ts`). No UI sets it; only `scripts/enable-creator-studio-for-org.ts`. Leave unset for the pilot.                                                                      |
| Inbox                         | No entitlement and no per-org flag. The page is reachable by every role (`inbox:read`), but stays empty unless the deployment has `INBOX_EMAIL_DOMAIN` and the webhook secrets configured. It cannot be switched off per organization without a code change. |
| Voice                         | `voiceAssistants = 0` on FREE **and** the deployment's `VAPI_*` configuration. Both must exist for voice to work.                                                                                                                                            |
| Chat voice input / live voice | Deployment env flags `AI_TRANSCRIPTION_ENABLED` / `AI_VOICE_CONVERSATION_ENABLED` plus allowlists (`src/env.ts`).                                                                                                                                            |
| Calendar providers            | Deployment env (`GOOGLE_CALENDAR_*`, `MICROSOFT_CALENDAR_*`, or `CALENDAR_MOCK_PROVIDER`). Booking works without any external calendar.                                                                                                                      |

Navigation shows items by role permission only (`src/components/layout/nav-items.ts`); Voice,
Workflows, Creator Studio and Inbox entries stay visible on FREE and show their upgrade or empty
state when opened.

## 3. Who can grant

Grants are a superadmin action, separate from the organization's own roles:

- A superadmin is a Supabase Auth user with `app_metadata.is_superadmin === true`
  (`src/server/auth/superadmin.ts`). This is set in the Supabase dashboard, never from the app
  (`docs/DEVELOPMENT.md`).
- `/admin` is in the middleware's protected prefixes; the `(superadmin)` layout redirects anyone
  who is not a superadmin to `/dashboard`.
- **Needs verification before the first pilot:** that a superadmin user exists in the target
  environment. This cannot be read from the repository.

## 4. Grant procedure (UI)

1. Sign in as the superadmin and open `/admin/organizations`. It lists the 50 newest
   organizations with plan, status and usage, and has a search box.
2. Open the pilot organization: `/admin/organizations/<orgId>`.
3. In the grant form (`src/components/admin/grant-form.tsx`), fill in:
   - **metric**: one of `MAX_SEATS`, `AI_MESSAGES_PER_USER_MONTH` (the stored name; it grants
     pooled messages per organization), `MAX_CONTACTS`, `KB_STORAGE_MB`, `ACTIVE_WORKFLOWS`,
     `VOICE_ASSISTANTS`, `VOICE_MINUTES_MONTH`, `AUDIT_RETENTION_DAYS`,
     `CREATOR_CREDITS_PER_MONTH`;
   - **amount**: a positive integer, **added** to the plan limit;
   - **reason**: required, up to 500 characters — write the pilot name and date;
   - **expiry**: optional date; an expired grant stops counting automatically.
4. Submit. `createEntitlementGrantAction` → `grantEntitlementOverride`
   (`src/server/services/billing/entitlement-grants.ts`) re-checks the superadmin, validates,
   inserts the `entitlement_grants` row with `grantedByUserId`, writes an audit row
   `entitlement_grant.create` (metric, amount, reason, expiry) and clears the cache.
5. Wait up to 60 seconds, then confirm the new limit on the organization's own
   `/settings/billing` plan card.

### Suggested pilot grants (intention, not a decision)

| Need                             | Metric                       | Amount to add                            |
| -------------------------------- | ---------------------------- | ---------------------------------------- |
| A team of up to 5 people         | `MAX_SEATS`                  | 3 (FREE already has 2)                   |
| Daily AI use for a small team    | `AI_MESSAGES_PER_USER_MONTH` | decide with Ehab; 50 is the FREE pool    |
| An existing customer list        | `MAX_CONTACTS`               | enough to cover the import, FREE has 200 |
| Knowledge documents beyond 50 MB | `KB_STORAGE_MB`              | as needed                                |

Do **not** grant `ACTIVE_WORKFLOWS`, `VOICE_ASSISTANTS`, `VOICE_MINUTES_MONTH` or
`CREATOR_CREDITS_PER_MONTH` for the first pilot: those features are intentionally off.

Every grant uses the same expiry date (for example the pilot's end), so the pilot winds down by
itself.

## 5. Removal and rollback

- **Revoke:** on the same admin page, the revoke button calls `revokeEntitlementOverride`, which
  sets `revokedAt` / `revokedByUserId`, writes an `entitlement_grant.revoke` audit row and clears
  the cache. Revoking twice is harmless.
- **Expiry:** expired grants stop counting without any action; they stay visible in the collapsed
  history on the admin page.
- **Rollback of a pilot:** revoke every active grant for the organization. The organization is
  back on plain FREE within 60 seconds. No data is deleted by this.
- **What revocation does to existing data:** nothing is removed. If the organization then exceeds a
  limit (for example 3 members on 2 seats), existing members keep working; only new invitations
  and acceptances are refused.

## 6. Audit trail

- `entitlement_grants` rows carry `grantedByUserId`, `createdAt`, `expiresAt`, `revokedAt`,
  `revokedByUserId`, and the free-text reason.
- Every grant and revoke also writes an `AuditLog` row in the organization
  (`entitlement_grant.create` / `entitlement_grant.revoke`). If that audit write fails, the grant
  itself still succeeds and the failure is only logged.
- The organization's own members can see these audit rows in `/settings/audit-log`.

## 7. Limitations

- Grants are additive only: they can raise a limit, never lower one, and never change the plan,
  subscription status or paid seats.
- `apiAccess` cannot be granted.
- There is no "feature" toggle; a grant is always a number on one metric.
- The admin UI is English only.
- The admin UI cannot create organizations, set feature flags, or do anything in Stripe.
- A grant never sends an email or notification to the organization.

## 8. What was not verified

- That a superadmin exists in the target environment, and who it is.
- That the admin pages render correctly on the environment used for the pilot (they are unit-tested,
  not covered by the staging smoke tests).
- Actual AI-message consumption of a real pilot team; set the first grant conservatively and raise
  it from the admin page as usage shows.
