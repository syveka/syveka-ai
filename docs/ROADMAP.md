# Syveka AI — Roadmap

Snapshot date: **2026-07-23**. Prioritized by production-safety and launch-readiness, based on
repository evidence in `SECURITY-AUDIT.md`, `DATABASE-AUDIT.md`, `AI-RAG-AUDIT.md`,
`CI-PRODUCTION-READINESS.md`, `UX-AUDIT.md`, and `FEATURE-INVENTORY.md`.

## P0 — Production blockers (must resolve before any production deploy)

### P0.1 — Fix failing dependency-audit CI gate
- **Business value**: unblocks the entire release pipeline; several CVEs involve SSRF/DoS in
  `next` itself.
- **Technical scope**: `npm audit fix` for `next`/`postcss`/`sharp`; separately evaluate
  `next-intl` 3.x→4.x (`npm audit fix --force`, breaking).
- **Dependencies**: none.
- **Risk**: Low for the non-breaking fixes; the `next-intl` major bump needs a migration-guide
  check against `src/i18n/*` usage before taking it.
- **Recommended sequence**: first item, before touching anything else.
- **Suggested milestone**: pre-staging-dispatch.

### P0.2 — Calendar webhook signature verification
- **Business value**: closes the one webhook endpoint without cryptographic verification.
- **Technical scope**: add Microsoft `clientState` and Google channel-token validation in
  `src/app/api/v1/webhooks/calendar/[provider]/route.ts`.
- **Dependencies**: none.
- **Risk**: Low; bounded blast radius today (forces idempotent resync only).
- **Suggested milestone**: pre-GA.

### P0.3 — Implement Content-Security-Policy
- **Business value**: standard defense-in-depth control expected for a SaaS handling
  AI-generated and third-party content; closes a stale-comment gap.
- **Technical scope**: implement the nonce-based CSP `next.config.ts`'s comment already
  describes, in `src/middleware.ts`, or remove the misleading comment if intentionally deferred.
- **Dependencies**: none.
- **Risk**: Low-medium — needs testing against every third-party script/style source actually
  used (Stripe Checkout, Vapi widget, etc.) to avoid breaking functionality.
- **Suggested milestone**: pre-GA.

### P0.4 — Rate-limit file/URL-ingestion endpoints
- **Business value**: closes a cost-amplification/probing-throughput gap.
- **Technical scope**: add `rateLimiters.api` (or a dedicated tier) to `kb/documents`,
  `kb/documents/upload-url`, `ai/files`, `ai/files/upload-url`.
- **Dependencies**: none — matches an existing, proven pattern.
- **Risk**: Low.
- **Suggested milestone**: pre-GA.

## P1 — Core launch requirements

- **Exercise the release pipeline end-to-end**: dispatch `staging-release.yml` for the first
  time, verify the full smoke checklist in `docs/release-runbook.md`, then a production
  dispatch. *Dependencies: P0 items resolved. Risk: process risk only if runbook is followed.*
- **i18n coverage completion**: localize `members-table.tsx`, `invite-form.tsx`,
  `api-keys-manager.tsx`, `organization-form.tsx`, `profile-form.tsx`, `onboarding-form.tsx`
  (Arabic branch missing entirely). *Business value: matches the stated en/fi/ar-parity
  principle; infrastructure already exists. Risk: low, mechanical work.*
- **Harden `getFreshTokens()`** in `calendar-connections.ts` to filter by `orgId` internally
  rather than relying on caller discipline (`DATABASE-AUDIT.md` §7). *Risk: low, no current
  exploit path, defense-in-depth only.*
- **Close the RAG general-search retrieval gap**: add `deleted_at`/`status='READY'` filtering
  to the `match_chunks()` path to match the documentId-scoped path (`AI-RAG-AUDIT.md` §6).
  *Risk: low, same-tenant consistency fix, not a security fix.*
- **Vapi webhook replay protection**: add timestamp/event-id dedupe matching the Stripe pattern.
  *Risk: low.*
- **Automated route-auth-coverage test**: assert every `src/app/api/v1/**/route.ts` imports a
  recognized auth/signature-check function, closing the "spot-checked, not exhaustive" gap.
  *Risk: low, pure test addition.*

## P2 — Product completion

- **Organization self-serve deletion**: implement the Server Action + confirmation UI for the
  already-defined `org:delete` permission and existing GDPR edge function backend.
- **Loading/error UX consistency**: add `loading.tsx`/`error.tsx` to chat, CRM, and calendar
  routes using the existing `/dashboard` pattern as a template.
- **Workflow trigger coverage verification**: confirm `contact.created`, `deal.stage_changed`,
  `deal.won`, `call.completed`, `schedule.cron` all have real `emitWorkflowEvent()` call sites
  (only `booking.*` was confirmed in this audit).
- **Decide the fate of dead infrastructure**: `zustand`, `@tanstack/react-query`,
  `fallbackModel()` OpenAI failover — finish or remove each, per `DECISIONS.md` open items.
- **Accessibility and mobile-responsiveness audit**: run an automated a11y pass (axe/Lighthouse)
  and a manual mobile-breakpoint pass; neither has been performed to date.
- **RTL visual verification**: check the deal Kanban board and calendar grid actually mirror
  correctly under `dir="rtl"`.
- **Observability**: decide whether to wire up Sentry/Langfuse (env vars already declared) or
  remove them until there's a concrete plan; add structured request logging if production
  incident response needs it (currently only 2 `console.error` sites exist server-wide).
- **Audit-log retention job**: verify or implement a purge job honoring `auditRetentionDays` per
  plan tier — not found in this pass.

## P3 — Growth features

- Public REST API surface beyond webhooks — the `resolveApiKey` auth helper already exists and
  is ready per `README.md`; no public API routes consume it yet.
- Outbound Google/Outlook calendar sync (inbound/import sync already exists).
- CSV contact import UI.
- PWA push notifications.
- RAG re-ranking.
- Custom-LLM voice mode.
- Portfolio / client-projects module.

## P4 — Future platform expansions

- Marketing Suite.
- Website Builder.
- Mobile applications.
- "Syveka Secure" — later paid security add-on.
- Release Notes system (public-facing changelog/release notes, distinct from the internal
  `docs/CHANGELOG.md`).
- AI Agents documentation (public-facing docs for the agent/tool-calling primitives already
  built into the chat and voice surfaces).

## Sequencing note

P0 and P1 are both narrow and mechanical relative to the size of the codebase — this is a
hardening/finishing phase for an already-mature core platform, not a rebuild. Do not let P2/P3/P4
scope creep into the current sprint; the stated priority is finishing the core platform before
any secondary product work begins.
