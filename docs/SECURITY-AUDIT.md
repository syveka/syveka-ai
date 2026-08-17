# Syveka AI — Security Audit

Snapshot date: **2026-07-23**. Every finding below is backed by direct code evidence (file and
line references as reported by the reviewing agent). Findings the prior review flagged are
explicitly re-verified against current code, not assumed fixed.

## Summary table

| #   | Finding                                                                                               | Severity           | Blocks production?                          |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| 1   | Dependency CVEs currently fail the blocking CI gate (`next`, `postcss`, `sharp`, `next-intl`)         | **High**           | Yes — fix before next release               |
| 2   | Calendar webhook has no signature/shared-secret verification                                          | Medium             | Recommended before GA, bounded blast radius |
| 3   | No Content-Security-Policy header, despite a comment claiming one exists                              | Medium             | Recommended before GA                       |
| 4   | No rate limiting on 4 file/URL-ingestion endpoints                                                    | Medium             | Recommended before GA                       |
| 5   | Vapi webhook has no replay-window check                                                               | Low                | No                                          |
| 6   | `/api` routes are unaudited exhaustively for self-enforced auth (spot-checked, not proven for all 18) | Low (process risk) | No                                          |
| 7   | DOCX parsing has no dedicated paragraph/structure limit (mitigated by other layers)                   | Informational      | No                                          |
| 8   | No structured request logging (only 2 `console.error` sites in server code)                           | Informational      | No                                          |

**Two headline concerns from prior context were re-verified and are genuinely fixed**:
SSRF/DNS rebinding and file-parsing resource limits. These are now the most solidly engineered
parts of the codebase. Full detail below.

---

## Critical

None found.

## High

### H1. Dependency CVEs currently fail the blocking production-dependency-audit CI gate

**Risk**: `npm audit --omit=dev --audit-level=high` — the exact command run by the blocking
`production-dependency-audit` job in `ci.yml` — currently exits 1 with **3 high + 1 moderate**
vulnerabilities, none of which were present when PR #9's CI last ran green (2026-07-20):

- `next` (nested transitive advisories): DoS in Server Actions, SSRF in Server Actions on
  custom servers, response-body cache confusion (×2), unbounded Server Action payload on Edge
  runtime, SSRF via rewrites, DoS in Image Optimization SVG handling, unauthenticated
  disclosure of internal Server Function endpoints.
- `postcss` ≤8.5.11 (nested under `next`): XSS via unescaped `</style>` in stringify output,
  arbitrary file read via `sourceMappingURL`.
- `sharp` <0.35.0 (nested under `next`, currently 0.34.5): libvips CVEs.
- `next-intl` ≤4.9.1 (currently 3.26.5): open redirect + prototype pollution.

**Evidence**: verified by running the exact CI command locally on 2026-07-23; fix available via
`npm audit fix` for the first three, `npm audit fix --force` (breaking, 3.x→4.x) for `next-intl`.

**Exploitation scenario**: several of the `next` advisories (SSRF via rewrites, unauthenticated
disclosure of internal Server Function endpoints) are directly relevant to a production
deployment of this app if left unpatched.

**Fix**: run `npm audit fix`, verify `npm run build`/`npm test` still pass, evaluate the
`next-intl` major-version bump separately (breaking change — check its migration guide against
`src/i18n/*` usage before taking it).

**Blocks production**: Yes — this is the literal gate that must pass before the next PR/staging
run succeeds; do not force-merge around it.

---

## Medium

### M1. Calendar webhook has no signature / shared-secret verification

**File**: `src/app/api/v1/webhooks/calendar/[provider]/route.ts`.

**Risk**: Unlike Stripe (HMAC via Stripe SDK) and Vapi (HMAC-SHA256 + `timingSafeEqual`), the
calendar webhook performs **no cryptographic verification at all**. Microsoft Graph supports a
`clientState` shared secret and Google supports `X-Goog-Channel-Token` specifically for this
purpose — neither is checked. The handler reads `x-goog-channel-id` or a JSON body's
`subscriptionId` and passes it straight to `handleProviderWebhook()`.

**Mitigating factor**: `handleProviderWebhook()` looks up
`calendarSyncState.findFirst({ where: { webhookSubscriptionId } })` — an attacker must know or
guess a valid, effectively-random, previously-issued subscription ID. The only effect of a
forged notification is triggering an **idempotent incremental sync** — no data is returned to
the caller and no state is corrupted; worst case is a mild DoS via wasted provider API calls.

**Exploitation scenario**: an attacker who obtains or guesses a subscription ID can force
repeated resyncs, consuming Google/Microsoft API quota. No cross-tenant data exposure.

**Fix**: add Microsoft `clientState` validation and Google channel-token validation before
production.

**Blocks production**: Recommended fix pre-GA, not a hard blocker given the bounded blast
radius.

### M2. No Content-Security-Policy header — comment claims one exists, it doesn't

**Files**: `next.config.ts` (lines ~4-6 comment), `src/middleware.ts` (full read, no CSP logic).

**Risk**: `next.config.ts` contains a comment: _"Static security headers (§13.2). The
nonce-based CSP is set in `src/middleware.ts` because it must vary per request."_ A full read
of `middleware.ts` and a repo-wide grep for `Content-Security-Policy`/`nonce` found **zero
matches**. There is no CSP anywhere in the application. This appears to be a stale comment from
a planned-but-never-implemented (or regressed) control.

**Mitigating factor**: no `dangerouslySetInnerHTML` or raw-HTML rendering was found anywhere in
`src/`, which meaningfully reduces the impact of the missing CSP today. Other security headers
(`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS, `Permissions-Policy`) are
correctly set.

**Fix**: either implement the nonce-based CSP the comment describes, or remove the misleading
comment if CSP was intentionally deferred — and track it explicitly in the roadmap either way.

**Blocks production**: Recommended before GA; standard expected control for a SaaS handling
AI-generated and third-party content.

### M3. No rate limiting on file/URL-ingestion endpoints

**Files**: `src/app/api/v1/kb/documents/route.ts`, `kb/documents/upload-url/route.ts`,
`ai/files/route.ts`, `ai/files/upload-url/route.ts`.

**Risk**: These four endpoints have `requirePermission()` but **no `rateLimiters` call**,
unlike login/register/AI-chat/public-booking, which all use the Redis-backed rate limiters
defined in `src/server/integrations/redis.ts`. `kb/documents` in particular triggers URL
ingestion (the SSRF-hardened fetch path) — while that path itself is safe against SSRF, it has
no per-minute throttle independent of the monthly storage-quota entitlement.

**Exploitation scenario**: an authenticated low-privilege user (any role with `chat:use` or
`kb:write`) can call these endpoints repeatedly, each spinning up a 20-second-timeout,
memory-limited worker thread for parsing — a cost-amplification and probing-throughput concern,
bounded only by the monthly document/storage entitlement, not by request rate.

**Fix**: add the existing `rateLimiters.api` tier (or a dedicated tier) to all four endpoints —
low-risk, matches an established pattern already used elsewhere.

**Blocks production**: Recommended before GA.

---

## Low

### L1. Vapi webhook has no replay-window check

**File**: `src/app/api/v1/voice/webhook/route.ts`, `src/server/integrations/vapi.ts`.

Real HMAC-SHA256 signature verification with `timingSafeEqual` is present and correct
(raw body read before parsing, correct order). There is no timestamp/replay-window check,
unlike Stripe (which has Redis dedupe on `event.id`). Impact is limited because handlers are
largely idempotent (`upsert` keyed on `vapiCallId`) and tool-call execution is permission-scoped.
**Fix**: add a timestamp check or event-id dedupe matching the Stripe pattern, low effort.

### L2. `/api` routes are not exhaustively proven to self-enforce auth

`middleware.ts`'s matcher (`config.matcher`) **excludes all `/api` routes**, meaning every one
of the 18 API route files must independently call `requirePermission()`/`getTenantContext()`/
`verifyJobRequest()`/a webhook-signature check, or it is completely unauthenticated. All
routes read during this audit (`ai/chat`, `ai/files*`, `kb/documents*`, `jobs/*`, `webhooks/*`,
`booking/*`) do this correctly — but this was a sample, not an exhaustive read of all 18 files,
and there is **no structural backstop** (no lint rule, no test) enforcing the pattern for future
routes. **Recommendation**: add an automated test asserting every file under `src/app/api/v1/**/
route.ts` imports one of the recognized auth/signature-check functions.

---

## Informational

### I1. DOCX parsing has no dedicated document-structure limit

`mammoth.extractRawText()` itself has no page/paragraph-count limit. The only bounds on DOCX
processing cost are the pre-inflation ZIP metadata checks (entry count, per-entry and
cumulative decompressed size, compression-ratio) plus the worker thread's memory/CPU/time
resource limits and the post-hoc output-length check — all of which are present and effective,
just not structure-specific. Fully offset by the layered mitigations; not a production concern.

### I2. No structured request/response logging

Only two `console.error` call sites exist in the entire server/API surface (`stripe/route.ts`,
`ai/chat/route.ts`), and neither logs secrets, tokens, or full request bodies. `pino` is listed
in `next.config.ts`'s `serverExternalPackages` but is not wired up with actual request logging
anywhere found. This is a minor observability gap for production incident response, not a
vulnerability — there's no accidental verbose-logging surface to worry about either.

---

## Areas verified clean (re-checked against prior-review concerns, not assumed)

| Area                                                                                | Verdict                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF / DNS rebinding** (`src/server/security/url-ingestion.ts`)                   | **Fixed — production-ready, the strongest-engineered part of the codebase** | DNS resolved once, every returned address validated, socket connects to the **literal pinned IP** (not the hostname) so no second DNS lookup can occur at connect time; redirects are re-pinned per hop; comprehensive IPv4 blocklist (private/loopback/link-local/CGNAT/multicast/reserved/TEST-NET) and IPv6 blocklist (loopback, ULA, link-local, Teredo, 6to4, NAT64, IPv4-mapped handled via recursive re-check of the embedded IPv4, not a static CIDR match); cloud-metadata hostname/IP blocked explicitly; body size bounded during streaming; 5-redirect cap; 20s timeout |
| **File parsing limits / zip bombs** (`parser-security.ts`, `document-ingestion.ts`) | **Fixed**                                                                   | 25MB max input, 2,000,000-char max extracted output (checked twice), 2,000-page PDF cap, 20s hard timeout via `worker_threads.Worker` with `maxOldGenerationSizeMb:64` (proven by a real test spinning up an infinite-loop worker and asserting forced termination), DOCX zip-bomb defense via **metadata-only** ZIP central-directory inspection (rejects ZIP64 — a classic bypass — caps entry count, per-entry and cumulative decompressed size, and compression ratio, all before any inflation occurs)                                                                         |
| **Stripe webhook**                                                                  | **Fixed**                                                                   | Raw body read before JSON parse, real `stripe.webhooks.constructEvent` signature verification, Redis `SET NX` dedupe on `event.id`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Auth middleware / superadmin gating**                                             | **Correct pattern**                                                         | Middleware's cookie check is a UX redirect only; real authorization is `supabase.auth.getUser()` at the data layer on every protected action; superadmin gated on `app_metadata.is_superadmin` (not user-writable), verified as a real per-request server-side check in the `(superadmin)` layout, not just route-group folder structure                                                                                                                                                                                                                                            |
| **XSS**                                                                             | No findings                                                                 | Zero `dangerouslySetInnerHTML`/raw-HTML rendering anywhere in `src/`; RAG chunk content is proactively sanitized (`sanitizeChunk()`) before reaching the LLM prompt                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **SQL injection**                                                                   | No findings                                                                 | Only 3 raw-SQL call sites in the whole server, all use Prisma's parameterized `Prisma.sql` tagged templates; no string concatenation found                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **CORS**                                                                            | No findings                                                                 | No explicit CORS headers found anywhere — Next.js defaults to same-origin, no permissive/wildcard policy present                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Secrets handling**                                                                | Clean                                                                       | `src/env.ts` Zod-validates every secret's shape at startup; client/server schemas are separate with a runtime guard against server-secret leakage into client bundles; `.env.example` has zero drift vs `env.ts`; `.env.local`/`.env*.local` gitignored                                                                                                                                                                                                                                                                                                                             |

## Production-blocking determination

Only **H1 (dependency CVEs)** is a hard blocker in the sense that it fails an existing,
already-enforced CI gate — the release pipeline will not let a deploy through until it's fixed.
M1–M3 are recommended hardening before general availability but do not involve authentication
bypass, cross-tenant data exposure, or injection — treat them as a pre-GA hardening sprint, not
an emergency.

---

### Addendum (2026-08-13) — Inbox and Business DNA are out of this audit's scope

This document's snapshot date (2026-07-23) predates the Inbox and Business DNA subsystems
entirely — both shipped afterward (`business_dna` in migration `20260811000000`, `inbox_threads`/
`inbox_messages` in `20260811010000`, roughly 150 commits behind this snapshot) and neither
appears anywhere above. This addendum does not re-run a full audit of either subsystem; it
records, for anyone reading this file as current, the security controls that shipped with them so
this document is not mistaken for a statement that they're unreviewed:

- **Tenant isolation**: both subsystems are scoped through `tenantDb`/`unscopedPrisma` with
  manual tenancy verification exactly where `tenantDb` can't reach (`InboxMessage`, parent-scoped
  via `threadId`) — same pattern as every other subsystem in this codebase. Live SQL-level RLS
  coverage (not just application-layer scoping) was added and verified against a real Postgres
  instance in `tests/rls/inbox-dna-isolation.sql`: `business_dna`'s real client policies reject
  cross-tenant insert/update/delete; `inbox_threads`/`inbox_messages`/`inbox_mailboxes` are
  confirmed default-deny (RLS enabled, zero client policies) rather than merely assumed so.
- **Prompt-injection boundaries**: untrusted inbound content (email bodies, thread history) is
  wrapped in labeled tags and passed through `neutralizeTagBreakout()` before reaching any AI
  system prompt, matching the same defense pattern used for booking guest notes and RAG chunk
  content elsewhere in this file's "Areas verified clean" table.
- **Webhook trust**: both inbound-email webhooks resolve the organization exclusively from a
  verified recipient address (`resolveOrgIdByMailboxAddress`), never from a client-supplied org
  id; the Resend endpoint verifies svix signatures over the raw body before parsing; both return
  an identical response for "bad secret" and "unregistered address" so neither webhook can be
  used to enumerate valid mailbox addresses.
- **Audit logging**: every state-changing mutation in `src/server/services/inbox.ts` is
  `audit()`-logged, including `markThreadRead`/`markThreadUnread` (added in this addendum's
  companion PR — previously the one gap in an otherwise fully-audited file).

This addendum is itself a snapshot, not a live feed. A dedicated, from-scratch security review of
Inbox and Business DNA — with the same file/line-level evidence standard as the rest of this
document — has not been performed and should not be assumed equivalent to one.

### Addendum (2026-08-17) — `tenantDb()` write-payload override closed for update/upsert/updateMany

A repository-wide launch-readiness audit re-verified the residual risk PR #73 had flagged as
latent-but-unexploited: `tenantDb(orgId)`'s Prisma Client Extension (`src/server/db/tenant.ts`)
injected `organizationId` into the `where` clause of `update`/`delete`/`upsert`/`updateMany`, but
— unlike `create()`, which safely spreads-then-overrides `data.organizationId` — never touched
the `data`/`create`/`update` write payload of those four operations. A caller passing a raw,
client-influenced object as that payload (e.g. `tenantDb(orgId).document.update({ where, data:
{ ...clientBody } })`) could have had `organizationId` silently reassigned to whatever the client
supplied, planting or moving a row into another tenant despite the `where` clause correctly
scoping the _lookup_.

Audited every live call site (grep for `.upsert(`, cross-referenced against `.update(`/
`.updateMany(` on `tenantDb(...)` instances): as of this snapshot, no call site passes a raw
client-supplied object into these payloads — every one either uses `unscopedPrisma` with an
explicit server-derived `organizationId`, or builds the payload from named, individually-typed
fields. **This was not exploitable through any current code path**, matching PR #73's own
assessment. It was fixed anyway, defensively, because it is a foundational shared security
primitive used by all 37 `TENANT_MODELS`-listed models, and the asymmetry with `create()` was a
standing trap for any future caller who reasonably assumed `tenantDb()` fully protects every
write the way it protects `create()`.

Fix: `update`, `upsert`, and `updateMany` now override `organizationId` in their write payload(s)
the same way `create()` already did, after any caller-supplied value. Covered by
`tests/unit/tenant-db.test.ts`, which drives `tenantDb()`'s `$allOperations` interceptor directly
for every write-shaped operation and asserts a spoofed `organizationId` is always overridden, not
merely accepted-and-ignored in `where`.

### Addendum (2026-08-17) — AI `bookMeeting` tool: unvalidated cross-tenant `contactId`

Found while independently reviewing a separate concurrency finding in the same function
(`src/server/ai/tools/index.ts`): the `bookMeeting` tool's optional, model-supplied `contactId`
input was passed directly into `calendarEvent.create()`'s `data.contactId` with no check that it
belongs to the caller's organization. `CalendarEvent.contactId` has no `@relation` declared in
`prisma/schema.prisma` — no DB-level foreign key exists — so nothing else in the write path would
have rejected a nonexistent or cross-tenant id either. The sibling `logActivity` tool, which takes
a structurally identical `contactId` input, already guards this with
`db.contact.findFirstOrThrow({ where: { id: input.contactId } })` (tenant-scoped via `tenantDb`)
before use — `bookMeeting` was simply missing the same one-line discipline.

Confidence: real, but bounded impact. `contactId` isn't attacker-_choosable_ in the sense of a
raw HTTP parameter — it only reaches `bookMeeting` via the model's own tool-call arguments, which
in the chat/voice product surfaces are populated from `searchContacts` results already scoped to
the caller's tenant — so the practical trigger is a hallucinated or injected UUID, not a
straightforward IDOR from an external caller. Still fixed, since nothing in the architecture
actually prevented it: `bookMeeting` now calls
`tx.contact.findFirstOrThrow({ where: { id: input.contactId, organizationId: id.orgId } })`
inside its transaction before attaching a supplied `contactId`, matching `logActivity`'s pattern.
Covered by `tests/unit/ai-tools-book-meeting.test.ts`.
