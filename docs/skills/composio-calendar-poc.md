# Composio Google Calendar Live PoC — Design & Evidence

Companion to `docs/skills/composio-integration.md` (the original evaluation, still the
authoritative REVIEW record). This document covers the live PoC attempt: Phases 0-4 completed,
**stopped at the mandatory human OAuth gate** — no OAuth was initiated, no Google account was
touched, no auth config was created. Nothing here changes `composio`'s registry status
(`status: REVIEW`, `integration_state: REFERENCE`, non-routable, `risk_level: HIGH` in
`syveka-skills/core/registry/data.ts`).

## Why this stopped before OAuth

Two independent blockers, discovered fresh in this session, neither about authorization:

1. **`COMPOSIO_API_KEY` is not present in this sandboxed session's environment.** It was
   validated successfully in a _different_ (the user's local) environment per this task's brief.
   Every live Composio call below - discovering the exact Google Calendar tool slugs, checking
   for an existing auth config, creating a new auth config, creating an OAuth link - requires this
   key. None of Phase 1's live-data steps, Phase 4's auth-config creation, or anything after it
   could actually be executed from here.
2. **`docs.composio.dev` is blocked by this sandbox's network egress policy** (confirmed via a
   direct fetch attempt, `EGRESS_BLOCKED`). Every fact below is instead grounded directly in the
   official `@composio/client` npm package's generated TypeScript source (`npm pack
@composio/client`, inspected file-by-file) - the same source of truth `scripts/verify-composio-key.ts`
   already used - never from memory.

Both are environment constraints, not authorization decisions. They mean this session could
prepare everything short of a live call, and had to stop one step earlier than Phase 4's own
"prepare the auth config" implies: I can specify the exact request Syveka would send, but cannot
report a live `auth_config.id` from creating it.

## Phase 1: API verification (grounded in the real, current SDK source)

All endpoints below are literal `this._client.get/post(...)` calls read directly out of
`@composio/client`'s generated `resources/*.js` files (Stainless-generated from Composio's own
OpenAPI spec) - not documentation, not memory.

| Concern                                                | Endpoint                                                             | Source file                       |
| ------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------- |
| Base URL                                               | `https://backend.composio.dev` (prod); `COMPOSIO_BASE_URL` overrides | `client.ts`                       |
| Auth header                                            | `x-api-key: <COMPOSIO_API_KEY>`                                      | `client.ts`                       |
| Toolkit info                                           | `GET /api/v3.1/toolkits/{slug}`                                      | `resources/toolkits.js`           |
| Tool listing                                           | `GET /api/v3.1/tools?toolkit_slug={slug}`                            | `resources/tools.js`              |
| Tool execution                                         | `POST /api/v3.1/tools/execute/{toolSlug}`                            | `resources/tools.js`              |
| Auth config create                                     | `POST /api/v3.1/auth_configs`                                        | `resources/auth-configs.js`       |
| Auth config list                                       | `GET /api/v3.1/auth_configs?toolkit_slug={slug}`                     | `resources/auth-configs.js`       |
| Auth config delete (+ optional revoke)                 | `DELETE /api/v3.1/auth_configs/{id}?revoke_on_delete=true`           | `resources/auth-configs.js`       |
| **OAuth link creation** (current, non-deprecated flow) | `POST /api/v3.1/connected_accounts/link`                             | `resources/link.js`               |
| Connected account retrieve                             | `GET /api/v3.1/connected_accounts/{id}`                              | `resources/connected-accounts.js` |
| Connected account list                                 | `GET /api/v3.1/connected_accounts`                                   | `resources/connected-accounts.js` |
| Connected account delete                               | `DELETE /api/v3.1/connected_accounts/{id}?revoke_on_delete=true`     | `resources/connected-accounts.js` |

**Connected-account creation flow (current vs. deprecated):** `connectedAccounts.create()`
(`POST /api/v3.1/connected_accounts`) is being retired for Composio-managed OAuth
(400 starting 2026-05-08 for new orgs, 2026-07-03 for all) in favor of `link.create()`
(`POST /api/v3.1/connected_accounts/link`) - this PoC design uses `link.create()` throughout, per
the SDK's own deprecation notice on the older method.

**`link.create()` request/response** (`resources/link.d.ts`):

```
POST /api/v3.1/connected_accounts/link
{ auth_config_id: string, user_id: string, alias?: string, callback_url?: string }
->
{ connected_account_id: string, redirect_url: string, link_token: string, expires_at: string }
```

`user_id` is the field that carries Syveka's identity into Composio - see "Tenant binding design"
below. `redirect_url` is the URL a human opens to complete Google's own OAuth consent screen.

**Tool execution takes an explicit `connected_account_id`** (`resources/tools.d.ts`,
`ToolExecuteParams`): `client.tools.execute(toolSlug, { arguments, connected_account_id })`. This
is the exact enforcement point for tenant binding (below) - nothing about _which_ Google account a
tool call acts on is inferred from the toolkit or the API key; it is exactly the
`connected_account_id` the caller supplies.

**Least-privilege mechanism** (`resources/auth-configs.d.ts`, `AuthConfigCreateParams`):
`auth_config: { type: 'use_composio_managed_auth', credentials: { scopes }, tool_access_config: {
tools_for_connected_account_creation: [...] } }` — `tools_for_connected_account_creation` is
described as "Tools used to generate the **minimum required scopes** for the auth config (only
valid for OAuth)." This is the real mechanism for narrowing Google's OAuth consent screen to only
what the 4 target tools need, rather than a broad default Calendar scope.

**Composio-managed vs. custom OAuth:** `AuthConfigCreateParams` is a union of
`use_composio_managed_auth` (no Google Cloud OAuth app needed - Composio's own registered app is
used) and `use_custom_auth` (bring your own Google OAuth client id/secret). Google Calendar is one
of Composio's own first-party-documented toolkits, so `use_composio_managed_auth` is expected to
work without any custom Google Cloud project - **this needs live confirmation** (see gap below),
but there is no SDK-level requirement for custom credentials.

**Disconnect/revoke semantics:** `authConfigs.delete(id, { revoke_on_delete: true })` and
`connectedAccounts.delete(id, { revoke_on_delete: true })` both start a background revoke job
(`revoke_job_id` returned); the SDK's own doc comment notes there is "not yet a generally
available" endpoint to poll that job's per-connection result - only the Composio dashboard shows
it. Revocation is stated as irreversible.

### Honest gap: exact Google Calendar tool slugs are NOT confirmed

Tool slugs (e.g., whatever Composio actually calls "list calendar events") are **data returned by
the live API**, not anything baked into the SDK - `npm pack`-ing the SDK and grepping it for
`GOOGLECALENDAR`/`googlecalendar` tool names returns nothing. Per this task's own instruction
("do not rely on remembered names"), I am not guessing them. `scripts/poc/composio-calendar/discover.ts`
(committed on this branch, not yet run) does `GET /api/v3.1/tools?toolkit_slug=googlecalendar` and
prints every real tool slug/name live - this is the one remaining live call needed before Phase 2
can name exact tools instead of describing them by capability ("list events", "create event", "get
event", "delete event").

## Phase 2: least-privilege design

Once `discover.ts` is run (needs the key), the design is:

- **Allowed tools**: exactly the 4 discovered slugs matching list-events / create-event /
  get-event / delete-event semantics - nothing else. `tools_for_connected_account_creation` at
  auth-config-creation time is set to exactly this list, so Google's OAuth consent screen is
  scoped to only what those 4 tools need (Composio computes the scope ceiling from the tools, not
  the other way around).
- **Explicitly excluded, by simply never including them**: calendar create/delete/ACL/sharing
  tools, batch/bulk event tools, webhook/push-notification subscription tools (Phase 6 requires no
  notification, so no webhook tool is requested), and any non-Calendar Google toolkit (Gmail,
  Drive, Contacts, Sheets, etc. are separate toolkit slugs entirely - never referenced here).
- **If Composio forces a broader scope than these 4 tools need** (a real possibility - some
  Calendar operations share one broad `calendar` OAuth scope rather than fine-grained per-action
  scopes; Google's own Calendar API has historically offered `calendar`, `calendar.events`, and
  `calendar.events.readonly` as the practical floor, not per-verb scopes) - per this task's Phase
  2 instruction, this is a STOP-and-report condition, decided only once `discover.ts` + a live
  `authConfigs.create()` dry run show the actual scope Composio computes. Not yet observed either
  way from this session.

## Phase 3: tenant/identity binding design — implemented and tested

See `scripts/poc/composio-calendar/tenant-binding.ts` (design) and
`scripts/poc/composio-calendar/tenant-binding.negative-test.ts` (**8/8 tests passing**, actually
run in this session - see "Test evidence" below).

**Binding**: `(organizationId, userId, provider="composio", toolkitSlug="googlecalendar") ->
composioConnectedAccountId`, mirroring this repo's real `CalendarConnection` model exactly
(`prisma/schema.prisma`: `@@unique([organizationId, userId, provider])`, scoped via
`src/server/db/tenant.ts`'s `tenantDb(orgId)`, which injects/overrides `organizationId` in every
query and write payload from a server-verified session, never a client-supplied value). If
Composio is ever promoted, the real implementation is a `CalendarConnection`-shaped row (or a
sibling table with the same shape) read through `tenantDb(orgId)` - **not** a new, parallel
mechanism.

**The enforcement point**: `buildToolExecuteRequest(registry, ctx, agentSuppliedArguments)` is the
single choke point every tool call goes through. It resolves `connected_account_id` _only_ from
`(ctx.orgId, ctx.userId)` - a server-verified pair, never a request body/header/query param or an
LLM/agent's tool-call arguments - and explicitly deletes any `connected_account_id`/`user_id`/
`entity_id` key an agent's arguments might contain before ever building the real
`tools.execute()` call. This mirrors `tenantDb`'s override of a client-influenced `organizationId`
in `create`/`update`/`upsert` payloads.

**Double-check against Composio's own report**: `verifyConnectionOwnership()` cross-checks
Composio's own `GET /connected_accounts/{id}` response's `user_id` field against what the tenant
binding expected, so a corrupted/misissued local mapping can never silently authorize a call
against a different Google account than intended.

## Phase 4: auth config — specified, not created

**Not started** (needs the live key). The exact request this PoC would send:

```
POST /api/v3.1/auth_configs
{
  "toolkit": { "slug": "googlecalendar" },
  "auth_config": {
    "type": "use_composio_managed_auth",
    "credentials": { "scopes": "<computed from tool_access_config, not hand-picked>" },
    "tool_access_config": {
      "tools_for_connected_account_creation": ["<4 slugs from discover.ts>"]
    },
    "name": "syveka-poc-googlecalendar-test-only"
  }
}
```

- **Composio-managed OAuth** (`use_composio_managed_auth`), not custom credentials - no Google
  Cloud OAuth app needs to exist for this PoC, _if_ live confirmation shows Composio's managed
  Google Calendar auth actually supports scoping to exactly these 4 tools. If it does not (Phase
  2's stop condition), custom credentials become the fallback and this document's "what you need
  to create" section would then apply.
- No write permission beyond the 4 named tools is requested.

## Test evidence (actually run in this session)

```
$ npx tsx scripts/poc/composio-calendar/tenant-binding.negative-test.ts
=== Tenant binding negative-test suite ===

PASS: resolves tenant A's own connection when given tenant A's server-verified identity
PASS: resolves tenant B's own connection when given tenant B's server-verified identity
PASS: CRITICAL: tenant A's context can NEVER resolve to tenant B's connected_account_id, even implicitly
PASS: CRITICAL: a malicious/compromised agent tool-call payload naming tenant B's connected_account_id is IGNORED and overwritten with tenant A's own
PASS: an org with no registered connection fails closed (throws), never returns a guessable/default id
PASS: a REVOKED connection fails closed even though a registry row still exists
PASS: identity cross-check rejects a connection whose Composio-reported user_id does not match the expected binding
PASS: identity cross-check accepts a connection whose Composio-reported user_id matches exactly

ALL PASS
```

`npx tsc --noEmit` (strict) and `npx prettier --check` and `npx eslint` all pass clean on every
file added in this PoC.

`scripts/poc/composio-calendar/discover.ts` was written and its fail-closed path (`COMPOSIO_API_KEY`
unset) was verified to exit 1 with a clear message and make zero network calls. Its live path
(actual toolkit/tool/auth-config discovery) has **not** been run - no key available in this
session.

## Phase 5 (security follow-up): OAuth scope vs. tool-execution are two independent boundaries

Live testing found the first auth config (`create-auth-config.ts`, using only
`tool_access_config.tools_for_connected_account_creation`) produced a Google OAuth scope of BOTH
`https://www.googleapis.com/auth/calendar` (broad - calendar/ACL management) and
`https://www.googleapis.com/auth/calendar.events` (narrow - events only), not `calendar.events`
alone. Attempting to force the narrow scope by additionally passing `credentials.scopes` alongside
`tool_access_config.tools_for_connected_account_creation` (`test-scoped-auth-config.ts`) failed
live with `HTTP 400`: _"You cannot provide both scopes (or user_scopes) and
tool_access_config.tools_for_connected_account_creation for the same auth config."_ No auth config
was created by that failed request.

**Root cause, confirmed directly from the `@composio/client` SDK's `AuthConfigCreateParams` /
`AuthConfigUpdateParams` types (`resources/auth-configs.d.ts`), not guessed:**
`tool_access_config` has **two independent fields**, only one of which is create-time and
scope-related:

- `tools_for_connected_account_creation` — "Tools used to generate the **minimum required
  scopes**... only valid for OAuth" - this is what conflicts with an explicit `credentials.scopes`
  at auth-config **creation** time (confirmed by the live 400 above).
- `tools_available_for_execution` — "The actions the user can perform on the auth config" - a
  **separate, execution-time allowlist**, present in `AuthConfigCreateResponse`/
  `AuthConfigRetrieveResponse`/`AuthConfigUpdateParams`, but **absent from `AuthConfigCreateParams`
  entirely** (grep-confirmed: it appears in the retrieve/list/update type shapes, never in the
  create-request shape). It is only ever set via `authConfigs.update(id, { tool_access_config: {
tools_available_for_execution: [...] } })`, **after** creation - and `AuthConfigUpdateParams`'s
  own type shows `scopes` and `tool_access_config.tools_available_for_execution` coexisting in the
  same update body with no documented conflict, unlike the create-time pairing that just failed
  live.

This means the create-time 400 is specific to `tools_for_connected_account_creation` (which
computes scope) conflicting with an explicit scope - it does **not** mean tool-execution
restriction and scope restriction are mutually exclusive in general. They are two genuinely
separate Composio mechanisms:

1. **OAuth scope** (what Google's consent screen shows, what the access token is capable of at the
   Google API level) - set via `credentials.scopes` at creation, alone, with no
   `tool_access_config`.
2. **Tool execution allowlist** (which of Composio's own tool slugs a connection using this auth
   config may call - enforced by Composio server-side, independent of what the underlying Google
   token could technically do) - set via `authConfigs.update()`'s
   `tool_access_config.tools_available_for_execution`, a separate call, after creation.

`scripts/poc/composio-calendar/test-scopes-only-auth-config.ts` tests boundary (1) in isolation
(create with `credentials.scopes` only, no `tool_access_config` at all) - live execution pending,
same pattern as prior scripts. Boundary (2) (the `authConfigs.update()` call) has **not yet been
attempted live** - identified from SDK types only, so it is honestly `NOT YET PROVEN`, not `PASS`.

**Additional supporting evidence for tool-level allowlisting as a first-class Composio concept**
(not required for this PoC, but corroborating): `resources/mcp/mcp.d.ts`'s MCP-server session
create/update params carry their own independent `allowed_tools: Array<string>` field - a second,
separate surface where Composio enforces a tool allowlist, reinforcing that this is deliberate
platform architecture, not a one-off.

**Syveka's own independent enforcement layer** (`scripts/poc/composio-calendar/tenant-binding.ts`)
remains a third, additive boundary regardless of what Composio enforces server-side: defense in
depth, not a substitute for either of the above, matching this repo's existing "database-level
protections are defense in depth, not a substitute" principle (CLAUDE.md §4) applied to a
third-party API instead of a database.

## What remains before the human OAuth gate can be answered concretely

1. Run `discover.ts` with a real `COMPOSIO_API_KEY` (in an environment that has one) to get the
   real Google Calendar tool slugs and check for an existing auth config.
2. Create the auth config per the Phase 4 spec above (or confirm an existing one already matches
   it) and read back the exact Google OAuth scopes Composio computed - this is the fact the human
   OAuth gate needs to state precisely, and this session cannot produce it without the key.

Only after both of those does `link.create()` produce a real `redirect_url` a human could
meaningfully be asked to open - which is exactly why this session stops here rather than
presenting a guessed scope list as if it were confirmed.
