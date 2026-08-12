# Inbox — Architecture & Resend Provider Setup

Referenced from `.env.example` (`INBOX_EMAIL_DOMAIN`) and `src/env.ts` — this is that document.

## Architecture overview

A unified, channel-agnostic conversation surface (`EMAIL` today; `SMS`/`WHATSAPP`/`WEB_CHAT` are
modeled in the `InboxChannel` enum but have no adapter implementation yet). Server-only by
design: every access path goes through the audited, RBAC-checked service layer, never a direct
Supabase client query (see `20260811010000_inbox_mvp_foundation`).

1. **Domain/service layer** — `src/server/services/`
   - `inbox.ts`: thread/message CRUD, `recordInboundMessage` (webhook entry point,
     idempotent on `externalId`), `approveMessage`/`sendMessage` (operator approval gate before
     any outbound dispatch), `markThreadRead`/`markThreadUnread`, assignment.
   - `inbox-ai.ts`: `generateEmailDraft` — builds the AI reply draft. Composes Business DNA
     (`@/server/business-dna/context`) and CRM contact/deal context (`@/server/crm/context`)
     into the prompt as labeled, structurally-neutralized untrusted data (see
     `@/server/ai/prompts/untrusted`'s `neutralizeTagBreakout`); never invents policy, pricing,
     or availability.
   - `inbox-mailbox.ts`: resolves which organization owns a verified inbound recipient address
     (`resolveOrgIdByMailboxAddress`) and lazily provisions an org's mailbox address
     (`getOrCreateMailbox`) from its slug + `INBOX_EMAIL_DOMAIN`.
2. **Channel adapters** — `src/server/channels/email/` (`types.ts` defines the
   `EmailChannelAdapter` interface): `resend.ts` (outbound send via the Resend SDK),
   `resend-inbound.ts` (inbound webhook parsing/verification/content-fetch), `mock.ts`
   (deterministic in-memory adapter for dev/test/credential-less environments). Selection is
   automatic (`index.ts`): `INBOX_EMAIL_MOCK_PROVIDER=1`, or non-production without a configured
   Resend key, forces the mock provider; otherwise Resend is used when configured.
3. **Transport**:
   - `/api/v1/inbox`, `/api/v1/inbox/[threadId]` — authenticated operator API (list/view/reply,
     `requirePermission`-gated).
   - `/api/v1/webhooks/inbox-email/resend` — the real Resend `email.received` webhook (see
     below).
   - `/api/v1/webhooks/inbox-email` — provider-agnostic webhook accepting the already-normalized
     payload shape (`inboundEmailWebhookSchema`); used for manual testing, fixtures, and any
     future provider that can emit the normalized shape directly without a dedicated adapter.

## Database

Schema: `prisma/migrations/20260811010000_inbox_mvp_foundation` (`inbox_threads`,
`inbox_messages`), `20260811020000_inbox_unread_and_idempotency` (`read_at` +
`external_id` uniqueness), `20260812000000_inbox_mailboxes` (`inbox_mailboxes`).

- RLS is enabled on all three tables but **no client policies are granted** — matching
  `document_upload_intents`/`calendar_connections`. Default-deny by omission, verified live (not
  merely assumed) by `tests/rls/inbox-dna-isolation.sql`.
- `tenantDb` scoping: `inboxThread`/`inboxMailbox` are org-owned models in `TENANT_MODELS`;
  `inboxMessage` is parent-scoped (resolved only through a verified `inboxThread`).
- `inbox_messages.external_id` carries a unique constraint: the provider message id
  (Resend's `email_id`) doubles as webhook-redelivery idempotency at the database layer.

## RBAC & security

- Every mutation in `inbox.ts` is `audit()`-logged, including `markThreadRead`/`markThreadUnread`.
- The organization is **never** read from a webhook payload — both inbound webhooks resolve it
  server-side from the verified recipient address via `resolveOrgIdByMailboxAddress`, reading
  through `unscopedPrisma` (pre-authentication by construction) rather than `tenantDb`.
- Both inbound webhooks return an identical "unauthorized" response whether the shared secret is
  wrong or the recipient address isn't registered to anyone — never confirms or denies which
  addresses exist.
- Outbound sending always requires an operator-approved message (`approveMessage` before
  `sendMessage`) — the AI draft is never sent unreviewed.
- Both webhook routes are rate-limited per resolved organization (`rateLimiters.inboxEmailWebhook`).

## Environment variables

```
INBOX_EMAIL_MOCK_PROVIDER        # "1" to force the mock provider outside development
INBOX_EMAIL_WEBHOOK_SECRET       # shared secret for the provider-agnostic webhook (min 16 chars)
INBOX_EMAIL_DOMAIN               # domain org mailboxes are provisioned under ({slug}@domain)
RESEND_INBOUND_WEBHOOK_SECRET    # Resend's svix inbound-webhook signing secret
RESEND_API_KEY                   # required for the outbound adapter AND inbound content fetch
EMAIL_FROM                       # outbound "from" header, e.g. "Syveka AI <no-reply@syveka.ai>"
```

All four inbox-specific variables are optional at boot: without them the mock provider serves
outbound send, and both inbound webhooks fail closed with `503 not_configured` rather than
accepting unauthenticated traffic.

## Resend provider setup (real inbound + outbound email)

This is the one genuinely undocumented manual setup in the provider list — completing it is
required before the email channel's setup-readiness state can move past `not_configured`.

1. **Domain** — in the Resend dashboard, add and verify the domain you intend to send/receive on
   (SPF/DKIM records Resend gives you; add them at your DNS provider). Set `INBOX_EMAIL_DOMAIN`
   to that verified domain — org mailbox addresses become `{org-slug}@{INBOX_EMAIL_DOMAIN}`,
   deterministic and collision-resistant since org slugs are already unique.
2. **MX records** — Resend's inbound-email docs specify the MX record(s) to point the domain (or
   a subdomain, e.g. `inbox.yourdomain.com`) at for receiving. Add exactly what the dashboard
   shows; a missing/incorrect MX record means inbound mail never reaches Resend at all — the
   webhook is never called, and no amount of app-side configuration can compensate for this.
3. **Inbound route** — configure Resend to route inbound mail on the verified domain to a
   webhook endpoint. Point it at:
   `{NEXT_PUBLIC_APP_URL}/api/v1/webhooks/inbox-email/resend`
4. **Webhook signing secret** — the Resend dashboard's Webhooks page shows a signing secret for
   that endpoint (svix-based: `svix-id`/`svix-timestamp`/`svix-signature` headers). Set
   `RESEND_INBOUND_WEBHOOK_SECRET` to that value — distinct from `INBOX_EMAIL_WEBHOOK_SECRET`,
   which only gates the separate provider-agnostic endpoint.
5. **API key** — `RESEND_API_KEY` (used for both outbound send and the inbound
   `GET /emails/receiving/{id}` content-fetch call the webhook makes after verifying the event).
6. **Per-organization mailbox** — once the domain/env vars above are live, each organization's
   mailbox address is provisioned automatically the first time an operator visits inbox settings
   (`getOrCreateMailbox`) — no separate manual per-tenant provisioning step.

### Manual verification checklist (do not claim this passed unless you actually performed it)

- [ ] Domain shows "Verified" in the Resend dashboard.
- [ ] `dig MX {your-inbound-domain}` resolves to the MX host(s) Resend's dashboard specified.
- [ ] Send a real email to an org's provisioned address; confirm a new `InboxThread`/
      `InboxMessage` row appears (visible in the Inbox UI, or via the setup-readiness dashboard
      widget, which only reports the email channel `ready` once a real inbound message with a
      provider `externalId` exists — see `src/server/services/setup-readiness.ts`).
- [ ] Approve and send a reply from the Inbox UI; confirm the recipient actually receives it and
      the message status transitions to `SENT`.
- [ ] Replay the same inbound webhook payload (or resend the same test email) and confirm no
      duplicate thread/message is created (`external_id` idempotency).
- [ ] Confirm a request to `/api/v1/webhooks/inbox-email/resend` with a missing/invalid
      `svix-signature` is rejected with `401`.

## Known limitations

- SMS/WhatsApp/web-chat channels are modeled (`InboxChannel` enum) but have no adapter
  implementation — email is the only live channel in V1.
- The provider-agnostic webhook (`/api/v1/webhooks/inbox-email`) has no built-in transport-layer
  authenticity guarantee beyond its shared secret — it exists for manual testing and future
  providers that can emit the normalized shape directly, not as a general-purpose ESP integration
  point.
- Inbound HTML is stripped to plain text for storage/display (`htmlToPlainText`) — it is a
  readability conversion, not a sanitizer; raw inbound HTML is never rendered as HTML anywhere in
  this codebase.
