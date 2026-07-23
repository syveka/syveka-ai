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
