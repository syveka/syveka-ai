# Syveka AI — Security Audit

Snapshot date: **2026-07-23**. Every finding below is backed by direct code evidence (file and
line references as reported by the reviewing agent). Findings the prior review flagged are
explicitly re-verified against current code, not assumed fixed.

## Summary table

| # | Finding | Severity | Blocks production? |
|---|---|---|---|
| 1 | Dependency CVEs currently fail the blocking CI gate (`next`, `postcss`, `sharp`, `next-intl`) | **High** | Yes — fix before next release |
| 2 | Calendar webhook has no signature/shared-secret verification | Medium | Recommended before GA, bounded blast radius |
| 3 | No Content-Security-Policy header, despite a comment claiming one exists | Medium | Recommended before GA |
| 4 | No rate limiting on 4 file/URL-ingestion endpoints | Medium | Recommended before GA |
| 5 | Vapi webhook has no replay-window check | Low | No |
| 6 | `/api` routes are unaudited exhaustively for self-enforced auth (spot-checked, not proven for all 18) | Low (process risk) | No |
| 7 | DOCX parsing has no dedicated paragraph/structure limit (mitigated by other layers) | Informational | No |
| 8 | No structured request logging (only 2 `console.error` sites in server code) | Informational | No |

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

**Risk**: `next.config.ts` contains a comment: *"Static security headers (§13.2). The
nonce-based CSP is set in `src/middleware.ts` because it must vary per request."* A full read
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

| Area | Verdict | Evidence |
|---|---|---|
| **SSRF / DNS rebinding** (`src/server/security/url-ingestion.ts`) | **Fixed — production-ready, the strongest-engineered part of the codebase** | DNS resolved once, every returned address validated, socket connects to the **literal pinned IP** (not the hostname) so no second DNS lookup can occur at connect time; redirects are re-pinned per hop; comprehensive IPv4 blocklist (private/loopback/link-local/CGNAT/multicast/reserved/TEST-NET) and IPv6 blocklist (loopback, ULA, link-local, Teredo, 6to4, NAT64, IPv4-mapped handled via recursive re-check of the embedded IPv4, not a static CIDR match); cloud-metadata hostname/IP blocked explicitly; body size bounded during streaming; 5-redirect cap; 20s timeout |
| **File parsing limits / zip bombs** (`parser-security.ts`, `document-ingestion.ts`) | **Fixed** | 25MB max input, 2,000,000-char max extracted output (checked twice), 2,000-page PDF cap, 20s hard timeout via `worker_threads.Worker` with `maxOldGenerationSizeMb:64` (proven by a real test spinning up an infinite-loop worker and asserting forced termination), DOCX zip-bomb defense via **metadata-only** ZIP central-directory inspection (rejects ZIP64 — a classic bypass — caps entry count, per-entry and cumulative decompressed size, and compression ratio, all before any inflation occurs) |
| **Stripe webhook** | **Fixed** | Raw body read before JSON parse, real `stripe.webhooks.constructEvent` signature verification, Redis `SET NX` dedupe on `event.id` |
| **Auth middleware / superadmin gating** | **Correct pattern** | Middleware's cookie check is a UX redirect only; real authorization is `supabase.auth.getUser()` at the data layer on every protected action; superadmin gated on `app_metadata.is_superadmin` (not user-writable), verified as a real per-request server-side check in the `(superadmin)` layout, not just route-group folder structure |
| **XSS** | No findings | Zero `dangerouslySetInnerHTML`/raw-HTML rendering anywhere in `src/`; RAG chunk content is proactively sanitized (`sanitizeChunk()`) before reaching the LLM prompt |
| **SQL injection** | No findings | Only 3 raw-SQL call sites in the whole server, all use Prisma's parameterized `Prisma.sql` tagged templates; no string concatenation found |
| **CORS** | No findings | No explicit CORS headers found anywhere — Next.js defaults to same-origin, no permissive/wildcard policy present |
| **Secrets handling** | Clean | `src/env.ts` Zod-validates every secret's shape at startup; client/server schemas are separate with a runtime guard against server-secret leakage into client bundles; `.env.example` has zero drift vs `env.ts`; `.env.local`/`.env*.local` gitignored |

## Production-blocking determination

Only **H1 (dependency CVEs)** is a hard blocker in the sense that it fails an existing,
already-enforced CI gate — the release pipeline will not let a deploy through until it's fixed.
M1–M3 are recommended hardening before general availability but do not involve authentication
bypass, cross-tenant data exposure, or injection — treat them as a pre-GA hardening sprint, not
an emergency.
