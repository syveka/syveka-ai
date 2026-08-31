# Syveka AI Skills Foundation — Repository Audit (Phase 1)

Read this before adding a new abstraction anywhere in this file tree. Its purpose is to prevent a
second Skills Registry, a second model router, or a second Business DNA store from being built by
someone who didn't know the first one existed.

## 1. There are two different "AI foundation" systems in this repository — do not conflate them

|                                  | `syveka-skills/` (repo root)                                                                                                                                    | `src/server/**` (the Next.js app)                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **What it is**                   | A standalone, model-agnostic **dev-tooling orchestrator** — a "Master Skill" that helps AI coding agents (Claude Code, Codex, Gemini CLI) work on Syveka safely | Syveka's **product** — the actual SaaS customers use (CRM, calendar, voice, chat, Business DNA) |
| **Who calls it**                 | An AI pair-programmer (you) doing engineering tasks                                                                                                             | Real tenants' browsers/API calls, Vapi, QStash jobs                                             |
| **Ships to production?**         | No — its own `package.json`, own `vitest.config.ts`, never imported by `src/`                                                                                   | Yes                                                                                             |
| **"Skills registry" here means** | Reviewed third-party tools an AI agent may use (Scrapling, shadcn-mcp, Remotion, …)                                                                             | N/A — no equivalent concept exists yet in the product                                           |
| **"Model router" here means**    | Which coding-agent CLI format to render instructions into (`adapters/claude-code`, `adapters/codex`, `adapters/gemini`)                                         | Which LLM (Claude/OpenAI model) answers a given product task                                    |

This mission's conceptual diagram (Business DNA → AI Orchestrator → Skills/Subagents/Tools → Model
Router → Claude/OpenAI/Gemini → Voice/Web/DMs/Booking/CRM → QA/Security/Audit) describes the
**product-facing runtime path** — the right-hand column above. `syveka-skills/` is real,
extensive, well-tested prior work, but it is not that system and should not be mistaken for it. It
is documented here (§2) and referenced (not duplicated) throughout this foundation pass.

## 2. `syveka-skills/` — existing dev-tooling foundation (reuse, do not rebuild)

Already implements almost everything Phases 2–3 of this mission ask for, for AI-assisted
engineering work:

- **Registry** (`core/registry/`, schema in `schemas/index.ts`): every entry has id, name,
  capability, provider, version/commit, source, license, `trust_level`, `risk_level`, `status`
  (APPROVED/EXPERIMENTAL/REVIEW/REJECTED/RESEARCH_ONLY), `integration_state`
  (REFERENCE→REVIEWED→INSTALLED→CONNECTED→VERIFIED, **earned, not granted**), permissions,
  network/filesystem/script/hook flags, dependencies, credential requirements, approval
  requirement, installation scope, review dates, security notes. This is a stricter superset of
  the metadata fields this mission's Phase 2 asked for.
- **Orchestration loop** (`core/orchestrator.ts`): intent → plan → route capability → check
  permission → gate approval → execute provider → collect evidence → verify → report. Every step
  emits a scrubbed `AuditEvent`.
- **Provider abstraction** (`providers/types.ts`): `{ id, isAvailable(), execute() }` returning a
  closed `SUCCESS | FAILURE | UNAVAILABLE` — no "sort of worked."
- **Model-agnostic adapters** (`adapters/claude-code`, `codex`, `gemini`): one shared capability
  list (`adapters/shared-capability-list.ts`), rendered per host CLI — this is the mechanism that
  makes the dev-tooling side "model-agnostic," proven by `evals/model-portability.test.ts`.
- **Security governance**: risk-based approval gating (`core/permissions/`, `policies/`), evidence
  - anti-sycophancy verification (`core/evidence/`, `core/verification/`,
    `evals/anti-sycophancy.test.ts`), secret-scrubbed audit trail (`core/reporting/audit.ts`,
    `evals/audit-secret-scrubbing.test.ts`), prompt-injection isolation for untrusted web content
    (`evals/scrapling-prompt-injection.test.ts`, `evals/untrusted-web-content.test.ts`).
- **Registry state today**: `local-test-runner`, `git-diff`, `skill-registry-lookup` — first-party,
  VERIFIED. `scrapling` (`web.research`) — the **only** external provider to reach VERIFIED, via
  real Docker + real network live testing (`evals/scrapling-live.test.ts`), documented in
  `docs/skills/scrapling-integration.md`. `remotion` (`video.render`) — VERIFIED via a real local
  Chromium render, ffprobe-confirmed. `shadcn-mcp` (`ui.component.provide`), `twentyfirst-dev`
  (`ui.component.discover`), `claude-video` (`video.analyze`) — registered but still `REVIEW` /
  `REFERENCE`, not routable.
- **Docs**: `syveka-skills/docs/{architecture,provider-model,security-model,skills-registry,
evidence-model,mvp,product-vision,commercialization}.md` — all current, all worth reading before
  extending this package further.

**What this foundation pass adds to `syveka-skills/`**: two new registry entries
(`chrome-devtools-mcp`, `firecrawl` — both non-routable, see §5), because this mission explicitly
asked for both to be evaluated. Nothing else in `syveka-skills/` needed rebuilding.

## 3. Product-facing AI infrastructure already in `src/` (reuse, extend carefully)

### Model routing — `src/server/ai/router.ts`

Already exactly what Phase 4 asks for, under different names:

```ts
type AiTask = "chat" | "deep" | "utility" | "title" | "sentiment" | "summary" | "draft";
```

Config-driven, provider-agnostic (`provider: "anthropic" | "openai"`), supports a per-conversation
pinned-model override. Used in 8+ call sites: `api/v1/ai/chat`, `jobs/post-call`,
`jobs/run-workflow`, `booking-assistant.ts`, `business-dna-extraction.ts`, `conversations.ts`,
`dashboard.ts`, `deals.ts`, `inbox-ai.ts`. This **is** the product's task-class → model layer this
mission's Phase 4 asks to formalize — it already exists and is in active use; it does not need
replacing, only documenting (`docs/skills/model-routing.md`, added this pass) and one real gap
closed (see below).

**Real, confirmed gap**: `fallbackModel()` is defined and exported but **never called anywhere** —
confirmed by repo-wide search. `src/server/integrations/anthropic.ts`'s own doc comment says
"Providers are wrapped behind this uniform signature so the model router can fail over to OpenAI,"
but no code path actually does that failover. `src/server/integrations/openai.ts` exists and is
used today only for embeddings (`embed`/`embedOne`) and moderation
(`isFlaggedByModeration`) — never for chat completion. This is an incomplete feature, not a bug in
working code, and touching the 8 existing call sites' error handling is out of scope for a
foundation pass ("do not rewrite stable systems"). This pass adds one new, additive, opt-in file
(`src/server/ai/fallback.ts`) — control-flow **scaffolding** toward failover, not failover itself:
no call site adopts it, and no real alternate execution path (an OpenAI chat completion) exists
for it to fall over to yet. It changes no existing behavior today (see §6). **Cross-provider
failover remains NOT WIRED in production after this pass.**

### Business DNA — already implements most of Phase 7

`src/server/business-dna/context.ts` (`getBusinessDnaContext(orgId)`) is the **single canonical
read/prompt boundary** — the doc comment in `docs/business-dna-mvp.md` states explicitly:
"Consumers must use it instead of re-querying or hand-formatting Business DNA." Chat, Voice (Vapi,
via `src/server/services/voice.ts`), inbox-ai, booking-assistant, deals, and setup-readiness all
read through this one path, queried live against `tenantDb` on every call — **there is no cache
layer today, which means there is also no staleness problem to protect against**: every consumer
already gets the current approved data on every call. `buildBusinessDnaPromptBlock` wraps the
output as untrusted/factual-only and neutralizes tag-breakout before it reaches a prompt. **There
is no second knowledge store to introduce or risk** — this foundation pass does not touch this
file and confirms no new one was added.

Website ingestion already exists and already satisfies the mission's critical Phase 7 rules:

- `src/app/api/v1/business-dna/extract/route.ts` + `src/server/services/business-dna-extraction.ts`
  — a **single-URL fetch, not a crawl service**: goes through the existing SSRF-safe
  `extractFromUrl` (`src/server/ai/extract.ts` → `src/server/security/url-ingestion.ts`), sanitizes
  the text, wraps it as explicitly untrusted `<source>` content, runs it through `routeModel
("utility")` (Haiku) with a strict "never invent facts" prompt, validates the result against
  `extractedBusinessDnaSchema`, and returns `{ data: ExtractedBusinessDNA, sourceUrl }` — nothing is
  persisted by this call.
- `RegenerateFromWebsite` (client component, `src/app/[locale]/(app)/settings/business-dna/`) —
  calls the extract endpoint, then hands the result to `handleExtracted()`, which **merges into
  the editable form fields only** — nothing is saved until the human clicks Save
  (`updateBusinessDnaAction`). Extracted data cannot silently overwrite approved data because there
  is no code path that writes it without that explicit save.
- Source is retained (`sourceUrl` is threaded through and stored on `BusinessDNA.sourceUrl` /
  `extractedAt` per `docs/business-dna-mvp.md`).

**Real, confirmed gap**: there is no **field-level** confidence/conflict indicator in the merge UI
today (e.g. "this field disagrees with what's currently saved" or "low confidence — please
verify") — `mergeExtractedTextFields` (per `src/lib/business-dna/merge-extracted.ts`) fills only
fields the extraction actually returned, leaving human-edited values elsewhere untouched, which
avoids the worst failure mode (silent overwrite) but doesn't yet surface a conflict when both an
existing value and a newly-extracted value disagree. This is a genuine, scoped **product feature**
(UI + a small data-shape change), not a foundation/architecture gap — it is documented as a NEXT
recommendation in `docs/skills/business-dna-ingestion-review.md` (added this pass), not built now,
per "Do NOT start unrelated product features."

### Browser QA — `playwright.config.ts` + `tests/e2e/smoke.spec.ts`

One spec file today: 5 public tests (login UI, FI landing, locale/RTL switch, unauthenticated
dashboard redirect, health endpoint + auth enforcement) + 5 authenticated tests (dashboard KPIs,
chat streaming, CRM contact create, deals kanban, companies/calendar/knowledge nav), across
`desktop`/`mobile` projects, gated by `VERCEL_AUTOMATION_BYPASS_SECRET` for staging runs. **Zero
coverage of Business DNA today.** This pass adds `tests/e2e/business-dna.spec.ts` reusing the exact
same patterns (see §7) — it does not introduce a second Playwright config or runner.

### RBAC / RLS / audit / rate limiting — all pre-existing, all reused as-is

- `src/server/auth/permissions.ts` — `Role` = `OWNER | ADMIN | MANAGER | MEMBER | VIEWER`, ~37
  fine-grained permission strings, `ROLE_PERMISSIONS: Record<Role, Set<Permission>>`,
  `can(role, permission)` / `permissionsFor(role)` as the single source of truth used by server
  actions, API routes, and the UI's `<Can>` guard. Already covers `business-dna:read/write`;
  `ui`-adjacent surfaces are not yet modeled (no permission exists for a future design-review or
  research feature — noted as a NEXT item, not created now since no such feature ships in this
  pass).
- Tenant isolation via `tenantDb(orgId)` + Postgres RLS (`auth_org_id()`) — this pass introduces no
  new tables or queries, so nothing new to isolate.
- `src/server/services/audit.ts` (`audit(ctx, { action, resourceType, resourceId?, before?, after?,
actorType? })`) — opt-in per call site (not middleware-enforced), already called from ~18 files
  including every Business DNA/service mutation; nothing in this pass performs a mutation, so
  nothing new needed auditing.
- `src/server/integrations/redis.ts` — existing rate limiters (`auth`, `api`, `aiChatUser`,
  `aiChatOrg`, `anonDemo`, `businessDnaExtract`, `inboxEmailWebhook`) already cover every
  network-facing AI surface relevant to this mission; no new endpoint was added in this pass, so no
  new limiter is needed.

## 4. RAG / embeddings / knowledge base

`src/server/integrations/openai.ts`'s `embed()`/`embedOne()` (text-embedding-3-small,
1536-dim) plus `src/server/ai/rag.ts` (`retrieveChunks`, `extractValidCitations`) and
`src/server/services/documents.ts` (chunking + embedding + retrieval) back the `/knowledge`
feature's document search — a working, narrow RAG path already in production, unrelated to and not
duplicated by anything in this pass.

## 4a. Design tokens — exist in code, undocumented

`tailwind.config.ts` + `src/app/globals.css` already define a full HSL-CSS-variable token system
(border/input/ring/background/foreground/primary/secondary/destructive/muted/accent/popover/card/
success/warning, `--radius`, `--font-sans`, `--font-arabic`), plus an ESLint-enforced RTL logical-
utility convention. No markdown document explains this system to a human or an AI agent before this
pass — see `docs/skills/design-skill-stack.md` §"Extract Design System," which points at these
exact files rather than re-deriving them.

## 5. MCP / tool evaluations added this pass

| Tool                    | Capability      | Status                                               | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chrome DevTools MCP** | `browser.debug` | `REVIEW` / `REFERENCE` (evaluated, not installed)    | Console errors, failed network requests, DOM/perf inspection — genuinely complementary to Playwright (which drives/asserts UI, not introspect runtime/network state) rather than a duplicate. Recommended integration path documented, not wired — needs the same MCP-host-level allowlisting/approval-gating pattern already established for Scrapling before any use against a real (even staging) target. See `docs/skills/chrome-devtools-mcp-evaluation.md`.                     |
| **Firecrawl**           | `web.research`  | `REJECTED` (deferred in favor of the existing entry) | Same capability Scrapling already fills, and Scrapling is already `VERIFIED` (real Docker isolation, real SSRF policy, live-tested) while Firecrawl would be a second, unreviewed, paid, hosted third-party service for the identical job — exactly the vendor-lock-in tradeoff `docs/skills/scrapling-integration.md` §6 already weighed against hosted scraping APIs. Re-open only if a concrete requirement Scrapling cannot meet (e.g. a managed-infra constraint) is identified. |
| Perplexity / Glif MCPs  | research        | Not evaluated this pass                              | No concrete Syveka requirement identified that Scrapling's `web.research` pipeline plus the app's existing `anthropic`/`openai` clients cannot already serve; evaluate on demand per the mission's own "do not install every MCP seen online" rule.                                                                                                                                                                                                                                   |

## 6. Design Skill Stack, Market Research Skill, AI Sales/DM Agent — status before this pass

None of these three had a spec or code home before this pass (confirmed: no "brand kit", "design
token", "competitor research", "market research", or "DM agent" file anywhere in `src/` or
`syveka-skills/`). `ui.component.provide` (shadcn-mcp) and `ui.component.discover` (twentyfirst-dev)
were already registered at `REVIEW` — they are the natural provider layer for a future Design Skill
Stack, referenced rather than re-evaluated. New specs added this pass: §Phase 6/8/9 documents below.

## 7. Dependencies present relevant to this mission

`@anthropic-ai/sdk` (0.39.0), `openai` (4.86.0) — both already direct dependencies, both already
wrapped (`src/server/integrations/{anthropic,openai}.ts`). No LangChain/LangGraph/Vercel AI SDK.
`@playwright/test` (1.50.0) already present. No Firecrawl, Puppeteer, or browser-automation package
beyond Playwright. Nothing new was added to `package.json` in this pass — everything built here
reuses these existing SDKs.
