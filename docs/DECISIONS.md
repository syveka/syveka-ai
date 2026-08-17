# Syveka AI — Decisions

Permanent decision log. Entries here must not be reversed without explicit owner approval.
Add new entries at the bottom with a date; never delete a prior entry (mark superseded instead).

## Process / roles

- **2026 (ongoing)** — Syveka is the primary long-term startup effort for the owner.
- **2026 (ongoing)** — ChatGPT manages product strategy, architecture decisions, PRDs, and
  technical planning.
- **2026 (ongoing)** — Codex handles coding, debugging, refactoring, and implementation.
- **2026 (ongoing)** — Claude is used only where it provides exceptional value (deep audits,
  cross-cutting documentation, large-context synthesis — this document set is an example).
- **2026 (ongoing)** — UX review and PRD come before major implementation.
- **2026 (ongoing)** — Database and AI-agent design come before feature coding.
- **2026 (ongoing)** — Core Syveka platform launch takes priority over secondary products
  (Marketing Suite, Website Builder, mobile app, Syveka Secure, Portfolio).
- **2026 (ongoing)** — Lowest reasonable monthly cost is a design principle; do not add a new
  paid service before checking whether an existing one already covers the need.
- **2026 (ongoing)** — English, Finnish, and Arabic support must remain consistent (enforced by
  `npm run i18n:check` in CI, currently at 488/488/488 key parity).
- **2026 (ongoing)** — Tenant isolation is mandatory.
- **2026 (ongoing)** — Production quality is required before launch.
- **2026 (ongoing)** — Completed items must not be removed from the roadmap without recording
  why.
- **2026 (ongoing)** — Previous architecture must not be restarted without evidence of a
  confirmed critical problem and explicit approval.

## Architecture decisions confirmed by repository evidence (this audit, 2026-07-23)

- **Tenant isolation is enforced at the application layer** via `tenantDb(orgId)` (a Prisma
  Client Extension auto-injecting `organizationId` for 32 allow-listed models) plus manual
  discipline at `unscopedPrisma` call sites, **not** by Postgres RLS — the app's Prisma
  connection uses a role that bypasses RLS. RLS remains fully enabled (43/43 tables) as a real
  backstop for the Supabase-native client surface (Storage, Realtime, PostgREST) only. **Do not
  change the database connection role to a non-bypassing role without an explicit architecture
  review** — RLS policies expect JWT claims the current connection doesn't carry, so switching
  roles would break functionality rather than freely add security. See `DATABASE-AUDIT.md` §6.
- **Anthropic Claude is the sole AI generation provider.** OpenAI is used only for embeddings
  and moderation. A model-router/fallback abstraction exists in code but is unwired dead code —
  do not assume multi-provider failover works until it is explicitly finished and tested.
- **AI chat streaming is intentionally buffered** (full generation + output moderation before
  any client flush, then replayed in fixed-size chunks) — a deliberate safety trade, not a bug.
  Any change here must preserve the moderation-before-flush guarantee.
- **RLS/SQL and Prisma migrations are two systems that must stay manually synchronized.**
  Supabase Storage bucket provisioning (`prisma/sql/004_storage.sql`) has no tracked-migration
  equivalent — document this as a required manual step in any fresh-environment runbook rather
  than assuming `prisma migrate deploy` alone provisions a working environment.
- **Money is stored in integer cents; IDs are UUIDs; every sensitive mutation calls `audit()`.**
  Repo-wide convention, confirmed in force across all audited services.
- **RBAC is a fixed 5-role matrix** (OWNER/ADMIN/MANAGER/MEMBER/VIEWER), defined once and
  enforced via `requirePermission()`. **Superadmin is a separate axis** gated on
  `app_metadata.is_superadmin`, not a role value — do not conflate the two systems in future
  design.
- **Corrective migrations are shipped as separate, clearly-commented additive migrations**, not
  folded into the migration they fix (established by
  `20260715230000_security_invariant_corrections`). Continue this convention.
- **Each major feature ships with a companion doc in `docs/`** describing architecture, RBAC,
  and known limitations at ship time (`ai-chat-production-hardening.md`,
  `calendar-booking-v1.md`, etc.). Continue this convention for future features.
- **Financial webhook idempotency must be a durable, database-backed state machine, not a
  Redis-only claim-before-confirm marker.** The Stripe webhook previously set its dedupe key
  before processing completed, so a transient failure after the claim permanently suppressed
  Stripe's own retry for that event. See `docs/stripe-webhook-reliability.md` for the
  RECEIVED/PROCESSING/COMPLETED/FAILED ledger (`stripe_webhook_events`) that replaced it —
  completion is recorded only inside the same transaction as the business mutation it depends
  on. Apply the same pattern (not necessarily the same table) to any future inbound webhook
  whose retries must never be silently dropped.
- **`tenantDb(orgId)` must override `organizationId` in every write payload it touches, not just
  `where`.** A 2026-08-17 audit found `update`/`upsert`/`updateMany` injected `organizationId`
  into `where` but left the `data`/`create`/`update` payload unguarded — unlike `create()`, which
  already spread-then-overrode it. No live call site was exploitable (all confirmed either
  `unscopedPrisma` with a server-derived `organizationId`, or built from named fields), but the
  asymmetry was a standing trap for a future caller. Fixed defensively in
  `security/p1-tenantdb-upsert-payload-injection`; see `docs/SECURITY-AUDIT.md`'s 2026-08-17
  addendum. Any future operation added to `tenantDb()`'s interceptor that carries a write payload
  must override `organizationId` in that payload, not only in `where`.
- **A "re-check inside `$transaction`" is not, by itself, concurrency-safe under Postgres's
  default READ COMMITTED isolation.** A 2026-08-17 audit found `createPublicBooking`/
  `rescheduleBookingViaToken` (`src/server/services/booking.ts`) documented as having
  "transactional double-booking protection," but the re-check was a plain `SELECT` with no lock —
  two concurrent transactions each see the other's write as absent until commit, so both can pass
  the check and both insert, producing two bookings for one slot. Proven against a real Postgres
  instance (not just a mocked unit test) via `tests/integration/booking-concurrency.sh`. Fixed by
  taking a transaction-scoped `pg_advisory_xact_lock` keyed on `(organizationId, ownerId)` before
  the check, so the second transaction blocks until the first commits/rolls back instead of
  racing it — see `lockOwnerCalendarForBooking()`'s comment. **Apply the same scrutiny to any
  future check-then-write inside a `$transaction`**: only a `SELECT ... FOR UPDATE`, an advisory
  lock, a unique/exclusion constraint, or `SERIALIZABLE` isolation with retry actually closes this
  class of race — re-running the same query inside the transaction does not.
- **`deepmerge-ts` is pinned to `8.0.1` via `package.json`'s `overrides`** (same mechanism already
  used for `next`'s `postcss`/`sharp` and `nanoid`). `@prisma/config` — a transitive dependency of
  the `prisma` CLI, itself pulled into the production `npm audit --omit=dev` closure because
  `@prisma/client` declares `"prisma": "*"` as a peer dependency — pins `deepmerge-ts` to an exact
  `7.1.5`, vulnerable to [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)
  (stack exhaustion merging recursive object graphs). As of this fix, every published `prisma`
  version from `6.13.0-dev.1` through the current `latest` (`7.9.1`) still depends on the same
  vulnerable pin — there is no available Prisma release that resolves this yet, so an override was
  the only viable fix. `deepmerge-ts` has zero dependencies of its own; `@prisma/config` only
  imports its basic `deepmerge` function (not `deepmergeInto` or the advanced type/metadata APIs
  `8.0.0`'s changelog documents as breaking), and `@prisma/config` is tooling-only (used by CLI
  commands like `prisma generate`/`validate`/`migrate`, never by `@prisma/client`'s runtime query
  execution) — bounding the blast radius of a mismatch to Prisma tooling, not the deployed app.
  Verified via the full local suite (tests, typecheck, lint, format, i18n, build, `prisma
validate`/`generate`, migration history check) after the override, all passing. **Revisit this
  override once Prisma ships a release with a patched `@prisma/config`** — remove it rather than
  leaving it to drift once the upstream fix lands.

## Standing engineering conventions (from `README.md`, verified still enforced)

- Never import `@/server/db/prisma` outside `src/server/db` (ESLint-enforced) — business code
  uses `tenantDb(ctx.orgId)`. Note: this does **not** restrict the `unscopedPrisma` escape hatch
  — see the RLS/tenant-isolation decision above.
- Every Server Action / API handler starts with `requirePermission("...")`.
- RTL: logical Tailwind utilities only (`ms-* me-* ps-* pe-* text-start`).
- Zod schemas in `src/lib/validators` are shared by forms and server actions.

## Open decisions requiring owner input (not yet resolved — see `NEXT-STEPS.md`)

- Whether to remove or finish `zustand` and `@tanstack/react-query` (currently installed, both
  unused beyond scaffolding).
- Whether to finish the OpenAI generation-failover path (`fallbackModel()`) or remove the
  aspirational comments/dead code referencing it.
- Whether to accept `next-intl`'s breaking 3.x→4.x upgrade now (required to clear a moderate
  CVE) or pin/patch around it short-term.
- Whether Sentry/Langfuse should actually be integrated (env vars exist, no SDK wired) or the
  optional vars should be removed until there's a concrete plan.
