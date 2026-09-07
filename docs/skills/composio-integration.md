# Composio — Integration Gateway Evaluation (not installed)

Companion to `docs/skills/SKILLS_REGISTRY.md` and `syveka-skills/core/registry/data.ts`'s
`composio` entry. Same evaluation format as `docs/skills/chrome-devtools-mcp-evaluation.md`: a
design/evaluation document written at the depth appropriate for a **REVIEW** entry — real facts
about the vendor, a real security-control design, a real PoC design — but **nothing here is
installed, connected, or wired into Syveka**. No production account was touched to write this.

## Status

**P1 — HIGH PRIORITY, EXPERIMENTAL / REVIEW REQUIRED.** Registered in
`syveka-skills/core/registry/data.ts` as `composio`, capability `integration.gateway`, `status:
REVIEW`, `integration_state: REFERENCE`. Not routable (`core/registry/index.ts`'s
`eligibleForRouting` excludes any `REVIEW` entry) until the conditions in §3 below are
independently reviewed and signed off — see `evals/composio-perplexity-providers.test.ts` for the
eval proving this in code, not just in the registry's `status` field.

## 1. What it is

[Composio](https://github.com/ComposioHQ/composio) (MIT license, verified against the official
repo 2026-09-07) is a hosted platform that gives AI agents pre-authenticated tool access to
"1000+ toolkits" — Gmail, Google Calendar, Google Drive, Slack, GitHub, CRMs, and other
productivity/business applications — by handling OAuth on the agent's behalf and exposing the
result as callable tools. It ships an official **hosted MCP endpoint** per session (works with
Claude, Cursor, and other MCP-compatible clients) so an agent session can discover and call
authorized tools without loading hundreds of static tool definitions into context. Access requires
a `COMPOSIO_API_KEY`; the platform separately manages OAuth for each connected third-party app.

Pricing (re-checked 2026-09-07, not authoritative — verify again before any spend decision): a
free tier (hard-capped, no credit card, roughly 20K managed-app tool calls/month or up to roughly
100K on a caller's own OAuth app), then metered paid tiers (starting around $29/mo) with per-call
overage pricing. Re-verify current pricing directly from `https://composio.dev/pricing` before any
billing decision — this document is not the source of truth for cost.

## 2. Where it fits Syveka's architecture

```
SYVEKA AI LAYER
├── Native Syveka Skills            (existing, e.g. calendar: src/server/integrations/calendar/)
├── Integration Providers
│   └── Composio                    ← THIS ENTRY (integration.gateway, REVIEW)
├── Research Providers
│   └── Perplexity                  (see docs/skills/perplexity-research-integration.md)
├── QA / Browser Tools
│   └── Playwright / Chrome DevTools MCP
└── Model Routing (src/server/ai/router.ts)
```

Composio is a candidate **Integration Provider** — a capability under `syveka-skills`' provider
model (`syveka-skills/docs/provider-model.md`), the same abstraction Scrapling and Remotion sit
behind. Nothing in `syveka-skills/core/` ever imports a provider directly; swapping Composio for a
different gateway (or removing it) means changing one registry entry and one `providerMap` — no
change to orchestration, permission, or evidence logic.

**Composio extends Syveka; it does not own Syveka.** Tenant isolation, RBAC, billing
authorization, and Business DNA ownership stay entirely inside Syveka's own application layer
(`src/server/`) regardless of what Composio is used for — see §4.

## 3. Required conditions before this can move past REVIEW/REFERENCE

All of the following must exist and be independently verified — not merely designed — before this
entry can become `status: APPROVED` and before any `providers/composio/` code beyond the current
honest stub (`createUnavailableStubProvider`) is written:

1. **Least-privilege OAuth scopes.** Every connected app is scoped to the narrowest permission set
   the actual use case needs (e.g. `calendar.events.readonly` before `calendar.events.write`), not
   a broad default scope requested for convenience.
2. **Explicit tenant/user identity.** Every Composio session/connection is bound to a
   server-verified Syveka tenant/user identity — never a client-supplied org or user id, per
   `CLAUDE.md` §4's standing tenant-isolation rule. This binding lives in Syveka's own application
   layer, not inferred from anything Composio reports about itself.
3. **No cross-tenant credentials.** One tenant's Composio connection/OAuth grant must never be
   selectable, reachable, or reusable from another tenant's request path — verified with the same
   rigor as Syveka's existing RLS/tenant-isolation tests (`tests/integration/*`, per
   `docs/DEVELOPMENT.md`).
4. **No secrets in prompts/logs/source control.** `COMPOSIO_API_KEY` and any OAuth tokens Composio
   returns must never be interpolated into an LLM prompt, written to application logs, or
   committed — sanitized the same way `src/server/*` already sanitizes secrets before they reach
   logs or responses (`CLAUDE.md` §4).
5. **Confirmation before destructive/high-impact actions.** Any action classified above `LOW` risk
   (see `policies/risk-classification.ts` — sending a message, writing a calendar event, mutating
   a CRM record are all `HIGH` by default under `DEFAULT_RISK`) must go through
   `syveka-skills/core/approvals/`'s human approval gate before executing, exactly like every other
   `HIGH`/`MEDIUM` action in this orchestrator.
6. **Auditability of external actions.** Every Composio-executed action produces a structured
   `AuditEvent` (`syveka-skills/core/reporting/audit.ts`), scrubbed of credential-shaped content,
   the same discipline every other provider in this registry already has.
7. **Safe token lifecycle.** A documented and tested issuance/rotation/revocation path for every
   OAuth token Composio holds on Syveka's behalf, including what happens to a tenant's connected
   accounts if that tenant is deleted or a user disconnects.
8. **GDPR and privacy review.** Composio is a US-based third party sitting between Syveka and a
   tenant's connected accounts (Gmail, Calendar, Drive, Slack, etc.) — a data-processing/privacy
   review (what data transits Composio, where it's stored, for how long, under what agreement)
   must complete before any EU tenant's data can reach it, consistent with Syveka's
   design-globally-and-multilingual-from-the-start posture and its existing EU-hosted Supabase
   project.
9. **Vendor-lock-in awareness.** Document exactly which Syveka product surfaces would depend on
   Composio if adopted, and confirm the integration is reachable only through the
   `integration.gateway` capability abstraction (never referenced by name from product code) so it
   stays replaceable, per `docs/provider-model.md`.
10. **Native Syveka fallback for critical integrations.** Any integration Syveka already implements
    natively (Google/Microsoft Calendar — `src/server/integrations/calendar/`) keeps its native
    implementation as the default; Composio is additive for integrations Syveka has no native
    implementation for, not a replacement for a working native one.

## 4. When an agent SHOULD use Composio

- An external SaaS integration that would otherwise require substantial custom OAuth/tooling work
  Syveka doesn't already have (e.g. a first Slack or a niche CRM integration with no existing
  Syveka provider).
- Isolated, project-scoped integration experiments explicitly approved for that experiment.
- An approved, user-connected service where the user has explicitly authorized the specific
  connection and scope.

## 5. When an agent must NOT use Composio

- Core Syveka database operations — those go through `src/server/db/` and tenant-scoped Prisma
  clients, never through a third-party gateway.
- Internal tenant authorization or RBAC decisions — `src/server/*permissions*`/`audit.ts` remain
  the sole authority, per `CLAUDE.md` §4.
- Billing authorization — Stripe integration (`src/server/` Stripe code) remains the sole path;
  Composio must never gate or execute a billing action.
- Security-critical decisions of any kind.
- Any operation Syveka already has a reliable native implementation for (see §3.10) — e.g. do not
  route Google Calendar operations through Composio while
  `src/server/integrations/calendar/google.ts` exists and works.
- Any destructive or state-changing action without a human approval already granted through
  `syveka-skills/core/approvals/` (see §3.5) — never silently, never by inference.

## 6. Security posture (evaluated, not live-tested)

- No live connection in this environment: no OAuth app registered, no `COMPOSIO_API_KEY`
  provisioned, no account (test or production) touched to produce this document.
- `providers/composio/index.ts` is an honest `createUnavailableStubProvider` — reports
  `UNAVAILABLE` rather than a fabricated success, same shape as `shadcn-mcp`/`twentyfirst-dev`/
  `claude-video` above it in the registry.
- Risk classified `HIGH` (`core/registry/data.ts`) because this is a gateway to credentialed,
  state-changing third-party actions across many app types — the highest-risk shape this registry
  currently models, above Scrapling's plain-HTTP-only `LOW` and Remotion's local-render-only
  `MEDIUM`.
- No `.env.example` entry added for `COMPOSIO_API_KEY` — per this task's own instruction, an env
  var is added only once real runtime integration requires it; adding one now would misleadingly
  suggest a live integration exists.

## 7. PoC design (not executed — design only, per this task's scope)

**Do not execute this PoC against a real account without the credentials and explicit owner
approval already in hand.** The design exists so a future, explicitly-authorized task can execute
it without re-deriving the plan.

**Test 1 — read-only:**

```
Syveka Agent → Composio → test Google Calendar account → list calendar events
```

**Test 2 — write + cleanup:**

```
Syveka Agent → Composio → create a clearly-labeled TEST calendar event
                        → verify an AuditEvent was recorded for the action
                        → delete the TEST event
                        → verify the delete is also audited
```

Both tests must exercise, and the resulting report must explicitly confirm or deny:

- OAuth flow completes and the resulting grant is scoped as expected (§3.1)
- The connection/session is correctly bound to a single test tenant/user identity (§3.2)
- No other tenant's session can reach this connection (§3.3)
- No token or secret appears in any captured log/prompt from the test run (§3.4)
- Error handling: a deliberately invalid request (bad scope, expired token, malformed input)
  produces a clean `FAILURE`, never a fabricated `SUCCESS`
- Retries: a transient failure (simulated) is retried with backoff, not silently swallowed or
  retried unboundedly
- Audit logging: every call produces a structured, scrubbed `AuditEvent`
- Disconnect/revoke: revoking the test connection actually prevents further calls, verified by a
  subsequent call attempt failing cleanly

Only once this PoC has run for real, passed, and an eval (`evals/*.test.ts`, following
`evals/scrapling-live.test.ts`'s opt-in, gated pattern) proves it automatically should
`integration_state` move to `CONNECTED`/`VERIFIED` and `status` be reconsidered for `APPROVED` —
see `syveka-skills/docs/skills-registry.md` "Integration state vs. review status" for why that bar
is earned, not granted.

## 8. What this pass actually shipped

- This evaluation document.
- One registry entry (`syveka-skills/core/registry/data.ts`, `composio`, `status: REVIEW`,
  `integration_state: REFERENCE`).
- One honest stub provider (`syveka-skills/providers/composio/index.ts`).
- Evals proving the stub is honestly unavailable and non-routable
  (`syveka-skills/evals/composio-perplexity-providers.test.ts`).
- No OAuth app created, no API key provisioned, no `.env.example` change, no account of any kind
  touched.
