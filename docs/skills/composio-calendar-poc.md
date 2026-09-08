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

## Phase 2 live result: OAuth-scope boundary — PASS (user-reported)

`test-scopes-only-auth-config.ts` was run live (outside this sandbox, which has no
`COMPOSIO_API_KEY`) against a third, separate auth config
(`syveka-poc-googlecalendar-events-scope-only`), created with `credentials.scopes` only and no
`tool_access_config` at all. Reported result: the auth config was created successfully and the
returned OAuth scope was **exactly** `https://www.googleapis.com/auth/calendar.events` — no
broader `calendar` scope present. **OAUTH LEAST PRIVILEGE: PASS.** This confirms the Phase 5
hypothesis that omitting `tool_access_config` entirely (rather than pairing it with
`credentials.scopes`, which 400s) lets the explicit scope request through unwidened.

This does **not** by itself prove tool-execution least privilege — that is a second, independent
Composio mechanism (Phase 5 above), tested separately in Phase 6 below.

## Phase 6: tool-execution allowlist boundary — update-only test on the existing scopes-only config

Per explicit task instruction, this phase does **not** create another auth config. It targets the
same `syveka-poc-googlecalendar-events-scope-only` config that just passed the OAuth-scope gate,
and tests **only** the second boundary identified in Phase 5:
`tool_access_config.tools_available_for_execution`, set via `authConfigs.update()` (`PATCH
/api/v3.1/auth_configs/{id}`), never at creation.

`scripts/poc/composio-calendar/test-tool-execution-allowlist.ts`:

1. **Discovers** the target auth config by exact name via `GET /api/v3.1/auth_configs?
toolkit_slug=googlecalendar&search=syveka-poc-googlecalendar-events-scope-only` — never a
   hardcoded id. Fails closed (exits 1, touches nothing) unless exactly one exact-name match is
   found, so it can never accidentally target the broad config
   (`syveka-poc-googlecalendar-test-only`) or the mutually-exclusive scopes+tools config
   (`syveka-poc-googlecalendar-scoped-test`).
2. **Reads the config BEFORE any change** and fails closed unless its current scopes are already
   exactly `[https://www.googleapis.com/auth/calendar.events]` — i.e. it refuses to proceed unless
   this really is the config Phase 2 just proved, not a same-named lookalike.
3. **Issues exactly one `PATCH`** with a body containing only `type` (echoed back unchanged from
   the pre-update read, so the auth type itself is never altered) and
   `tool_access_config.tools_available_for_execution` set to the 4 approved tool slugs
   (`GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_EVENTS_GET`,
   `GOOGLECALENDAR_DELETE_EVENT`). No `credentials`, `scopes`, or `user_scopes` field is included in
   the request body — per the SDK's own JSDoc on `update()`, "Only specified fields will be
   updated," so an omitted field must not change.
4. **Re-reads the config independently AFTER the update** (a fresh `GET`, not the `PATCH`
   response body) and fails closed (`TOOL EXECUTION LEAST PRIVILEGE: BLOCKED`, non-zero exit)
   unless **both**:
   - the returned `tools_available_for_execution` is exactly the 4 approved slugs, no more and no
     fewer, and
   - the OAuth scopes after the update are byte-for-byte identical to the scopes before it.

No connected account, `link.create()`, or any other OAuth-initiating call is referenced anywhere
in the script. Confirmed locally in this sandbox (no `COMPOSIO_API_KEY` present): fail-closed path
exits 1 with zero network calls; `npm run typecheck`, `npm run lint`, `npm run format:check` all
PASS; `tenant-binding.negative-test.ts` re-run unaffected (8/8 PASS). **Live execution of this
script has not yet occurred** — same pattern as prior phases, it must be run in an environment
holding the real key, with results reported back before the gate below can be marked PASS/BLOCKED
for real.

**Status at end of this phase:** script written and validated; live run **pending**. Once run,
the operator should record here: the resolved auth-config id, scopes before/after, the requested
vs. returned execution allowlist, and the final `TOOL EXECUTION LEAST PRIVILEGE: PASS/BLOCKED`
verdict — mirroring the Phase 2 live-result entry above.

## Phase 6 live result: tool-execution allowlist boundary — PASS (re-confirmed live, this session)

Read-only re-verification against `ac_KIeGPcIy9Yo9`
(`syveka-poc-googlecalendar-events-scope-only`) via `GET /api/v3.1/auth_configs` (exact-name
search) and `GET /api/v3.1/auth_configs/{id}`, run fresh in this session:

- `status`: `ENABLED`
- `is_composio_managed`: `true`
- `credentials.scopes`: exactly `["https://www.googleapis.com/auth/calendar.events"]` — unchanged
  from the Phase 2 result
- `tool_access_config.tools_available_for_execution`: exactly
  `["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_CREATE_EVENT", "GOOGLECALENDAR_EVENTS_GET", "GOOGLECALENDAR_DELETE_EVENT"]`
  — 0 missing, 0 extra

**TOOL EXECUTION LEAST PRIVILEGE: PASS** (both boundaries independently re-verified live, not just
carried forward from a prior session's report). `tenant-binding.negative-test.ts` re-run fresh in
this session: 8/8 PASS.

## Phase 7: OAuth link generation — BLOCKED on API key permissions (not an authorization decision)

`scripts/poc/composio-calendar/create-oauth-link.ts` was added: it re-discovers the approved auth
config by exact name, re-verifies both boundaries above immediately before acting (fail-closed if
either has drifted), then calls `POST /api/v3.1/connected_accounts/link` with the auth config id
and a fixed, clearly-labeled TEST `user_id` (`syveka:org-test-poc:user-test-poc` — never a real
Syveka org/user).

**Live result: `HTTP 403 APIKey_InsufficientPermissions`** — "This API key does not have the
permissions required for POST /api/v3/connected_accounts/link. This route requires
\"connected_accounts\" write access, but the key has no access for \"connected_accounts\"." A
follow-up read-only check (`GET /api/v3.1/connected_accounts`) also returned the same 403 — the
key has **zero** `connected_accounts` scope, neither read nor write. It only has `auth_configs`
read/write (confirmed working throughout Phases 1-6) and, separately, tool-execution access (not
yet exercised).

This is an environment/credential-scoping fact, not a decision about whether OAuth should proceed.
Per CLAUDE.md §9 (credential/secret modification is a protected action requiring explicit
authorization) this session will not attempt to widen the key's own permissions. Two paths forward,
both requiring a human action outside this session:

1. Grant the existing `COMPOSIO_API_KEY` `connected_accounts` read+write permission in the
   Composio dashboard, then re-run `create-oauth-link.ts` to get a real `redirect_url`; or
2. Generate the connection link directly from the Composio dashboard's UI against the
   `syveka-poc-googlecalendar-events-scope-only` auth config (id `ac_KIeGPcIy9Yo9`) using the same
   TEST `user_id` (`syveka:org-test-poc:user-test-poc`), and share the resulting `redirect_url`
   and `connected_account_id` back into this session before Phase 4 (post-OAuth verification) can
   run.

Nothing about the two previously-proven boundaries (OAuth scope, tool-execution allowlist) is
affected by this — they remain independently re-verified PASS above. No OAuth was initiated, no
Google account was touched, no connected account was created by this attempt (the 403 occurred
before Composio created anything).

## Phase 7 (continued): `connected_accounts` permission granted; link created; OAuth completed live

Between sessions the `COMPOSIO_API_KEY` was granted `connected_accounts` read+write in the
Composio dashboard (a human action outside this repo, not performed by this session). Re-running
the same, unmodified `create-oauth-link.ts`:

- Pre-check found exactly one PRIOR connected account for the TEST identity
  (`ca_q0GN7TbsCWZB`), status `EXPIRED` (from an earlier dashboard-generated link that expired
  unused) — not an active/conflicting duplicate, so creating a new session was safe.
- Created exactly one new connection: `connected_account_id = ca_1K8XM43hx7CM`,
  `redirect_url = https://connect.composio.dev/link/lk_[REDACTED - single-use, already expired and
consumed, but link tokens are not committed to tracked docs]`,
  `expires_at = 2026-09-07T22:34:34.315Z`. `requested_scopes` on the new connection: exactly
  `["https://www.googleapis.com/auth/calendar.events"]`.
- A human opened that link with a disposable TEST Google account and completed Google's consent
  screen; Composio reported "Successfully connected Composio to Google Calendar."

## Phase 4 live result: post-OAuth connection verification — PASS

`scripts/poc/composio-calendar/post-oauth-verify-and-list.ts` was added: reads back the exact
connected account by id (never re-discovered), cross-checks its reported `user_id` against the
expected TEST binding via `tenant-binding.ts`'s real `verifyConnectionOwnership()` (the same
enforcement code, not a parallel check), re-verifies the auth config's scope and execution
allowlist are unchanged, then builds the tool-execute request via `buildToolExecuteRequest()` -
deliberately passing a bogus `connected_account_id`/`user_id` in the "agent-supplied" arguments to
prove at runtime, not just in the unit test, that they are discarded in favor of the
server-resolved TEST connection.

Live result against `ca_1K8XM43hx7CM`:

- `status`: `ACTIVE` (not `INITIALIZING`/`EXPIRED`)
- `user_id`: exactly `syveka:org-test-poc:user-test-poc` — matches the expected TEST binding
- `auth_config.id`: `ac_KIeGPcIy9Yo9` — matches the approved config
- `requested_scopes`: exactly `["https://www.googleapis.com/auth/calendar.events"]`
- Auth config re-read fresh: scopes and `tools_available_for_execution` both still exactly as
  established in Phases 2 and 6 - 0 missing, 0 extra
- `buildToolExecuteRequest()` resolved `connected_account_id = ca_1K8XM43hx7CM` from the
  server-verified TEST tenant context only; the bogus agent-supplied
  `connected_account_id`/`user_id` were discarded, never reaching the executed request

**POST-OAUTH CONNECTION VERIFICATION: PASS.**

## Phase 5 live result: read-only smoke test — BLOCKED on a second, separate API key permission gap

The same script's Step 5 called `POST /api/v3.1/tools/execute/GOOGLECALENDAR_EVENTS_LIST` (the
only tool invoked - no CREATE/UPDATE/DELETE tool referenced anywhere in this script) using the
tenant-resolved `connected_account_id`. **Live result: `HTTP 403
APIKey_InsufficientPermissions`** — "This route requires \"tool_execution\" write access, but the
key has no access for \"tool_execution\"." This is a third, independent permission scope on the
same API key (distinct from `auth_configs` and `connected_accounts`, both already granted) - not
yet granted.

Per the same rule as Phase 7's `connected_accounts` gap, this session will not attempt to widen
the key's own permissions (CLAUDE.md §9). Unblocking requires a human to grant this
`COMPOSIO_API_KEY` `tool_execution` permission (read is sufficient for `GOOGLECALENDAR_EVENTS_LIST`;
write is required for the later CREATE/DELETE roundtrip) in the Composio dashboard, after which
`post-oauth-verify-and-list.ts ca_1K8XM43hx7CM` can be re-run unmodified to complete the read-only
smoke test.

**Everything provable without that permission has passed**: the connected account is active and
correctly tenant-bound, OAuth scope and execution allowlist remain exact and unwidened, and the
tenant-binding enforcement code resolves the connection correctly under a simulated
cross-tenant-payload attack. Only the actual Google Calendar API round-trip is pending.

## New session re-verification: `tool_execution` permission still not granted (as of this check)

A later session's task brief stated the key "should now have" `tool_execution: Read + Write`.
Re-running the identical, unmodified `post-oauth-verify-and-list.ts ca_1K8XM43hx7CM` live in this
session reproduced the exact same outcome as Phase 5 above, with no changes:

- Connected account `ca_1K8XM43hx7CM`: still `status: ACTIVE`, still bound to exactly
  `syveka:org-test-poc:user-test-poc`, still `auth_config.id: ac_KIeGPcIy9Yo9`.
- Auth config `ac_KIeGPcIy9Yo9`: OAuth scope still exactly
  `["https://www.googleapis.com/auth/calendar.events"]`; execution allowlist still exactly the 4
  approved `GOOGLECALENDAR_*` slugs, 0 missing / 0 extra.
- `tenant-binding.negative-test.ts` re-run fresh: 8/8 PASS.
- `GOOGLECALENDAR_EVENTS_LIST` call: still `HTTP 403 APIKey_InsufficientPermissions` — _"This
  route requires 'tool_execution' write access, but the key has no access for
  'tool_execution'."_ Byte-for-byte the same error as before.

**Conclusion: the `tool_execution` permission has not actually been granted on this key yet**,
regardless of what the task brief assumed. Per that same brief's own instruction ("Do not request
broader Composio permissions unless a current live API call proves they are strictly required" -
this call just did) and its Phase 3 instruction ("If LIST fails: diagnose honestly and STOP before
mutations"), this session stopped here. **Phases 4-7 (CREATE/GET/DELETE/cleanup) were not
attempted** - none of the four approved tools were ever called against a live Google Calendar in
this session. Unblocking requires a human to grant `tool_execution` (read+write, to cover the full
LIST -> CREATE -> GET -> DELETE roundtrip) to this `COMPOSIO_API_KEY` in the Composio dashboard, after
which `post-oauth-verify-and-list.ts ca_1K8XM43hx7CM` should be re-run first to confirm LIST
succeeds before any mutating call is attempted.

## `tool_execution` permission granted; LIST succeeded; PoC halted - connected account is NOT a disposable TEST account

A subsequent session's `COMPOSIO_API_KEY` was updated to a key with `tool_execution` granted. A
fresh side-effect-free permission probe (`POST /tools/execute/GOOGLECALENDAR_EVENTS_LIST` with a
deliberately invalid `connected_account_id`) got past `APIKey_InsufficientPermissions` entirely,
returning a different, unrelated `400 ActionExecute_ConnectedAccountEntityIdRequired` validation
error instead - confirming the permission gate now passes.

Re-running `post-oauth-verify-and-list.ts ca_1K8XM43hx7CM` reproduced Steps 1-4 exactly as before
(connected account `ACTIVE`, tenant binding exact, OAuth scope and execution allowlist both exact,
0 missing/0 extra), then Step 5 failed with the same `ActionExecute_ConnectedAccountEntityIdRequired`
error the probe surfaced: the live `/tools/execute/{slug}` endpoint requires an explicit
`entity_id` field alongside `connected_account_id`, which the script did not send. This is a
narrow, live-proven API contract gap, not a security or scope issue - fixed by adding
`entity_id: TEST_COMPOSIO_USER_ID` (the same TEST identity already verified in Steps 1-2, never a
new or caller-supplied value) to the execute request body.

**With that fix, `GOOGLECALENDAR_EVENTS_LIST` executed successfully (`HTTP 200`)** through the
tenant-resolved connected account, with the bogus agent-supplied `connected_account_id`/`user_id`
proven discarded at runtime (Step 4's existing check).

**However, the LIST response itself revealed the connected Google account is not a disposable TEST
account.** The returned calendar's owner/creator email and its event contents (a real birthday
entry, personal event titles, recurring personal appointments) identify it as a real personal
Google account, not a sandbox/throwaway one. This directly contradicts the requirement stated in
every phase of this PoC's task briefs ("disposable TEST Google account only," "no
personal/business Google account") and matches an explicit stop condition ("a non-test Google
account is targeted" -> STOP immediately).

**This session therefore stopped after Step 4 (LIST) and did not attempt Phase 5 (CREATE) or any
later phase.** No event was created, read, or deleted against this account. Continuing the
roundtrip (CREATE/GET/DELETE) requires either reconnecting `ac_KIeGPcIy9Yo9` to an actual
disposable/sandbox Google test account, or explicit human confirmation that this specific Google
account is intentionally being used as the PoC's TEST account (which would be a deliberate change
to this PoC's own safety boundary, not something this session will assume on its own).

No personal calendar content is reproduced in this document.

## Second attempt: fresh OAuth link, second connected account - also NOT a disposable TEST account

A fresh, single `create-oauth-link.ts` run (re-verifying scope and allowlist immediately before
acting, per its existing design) created one new, independent connected account,
`ca_VVelgy-yeV_C`, for the same TEST identity (`syveka:org-test-poc:user-test-poc`) and the same
approved auth config (`ac_KIeGPcIy9Yo9`) - without modifying or deleting the earlier personal
connected account (`ca_1K8XM43hx7CM`), which remains untouched and `ACTIVE`. A human completed
Google's OAuth consent screen against this new link with what was intended to be a disposable TEST
Google account.

Re-running `post-oauth-verify-and-list.ts ca_VVelgy-yeV_C` (unmodified): connected account
`ACTIVE`, tenant binding exact, OAuth scope and execution allowlist both exact (0 missing/0
extra), and `GOOGLECALENDAR_EVENTS_LIST` executed successfully (`HTTP 200`).

**The LIST response again revealed a real, non-disposable Google account** - this time a
different real account than the first attempt, containing a genuine external meeting invite (a
real named external attendee at an outside organization, with business content embedded in the
event description). This is not sandbox/placeholder data.

**This session stopped immediately after LIST and did not attempt CREATE/GET/DELETE against this
account either**, per the same explicit stop condition. Two consecutive OAuth completions have now
each connected a real Google account rather than an empty, disposable test one. Continuing this
PoC's mutation phases requires a Google account created specifically for testing, with **zero**
real calendar data on it - not merely an account the human considers "for testing" while it still
holds real personal or business events. No personal or business data (attendee names, emails, or
message content) is reproduced in this document.

## Third attempt: genuinely empty TEST calendar confirmed; LIST/CREATE roundtrip attempted

A third connected account, `ca_IUyc1cphBOF4`, was created the same way (one `create-oauth-link.ts`
run, same TEST identity, same auth config, neither prior connection touched) and OAuth was
completed against a Google account created specifically for this PoC. Post-OAuth verification
passed in full (`ACTIVE`, exact tenant binding, exact scope, exact allowlist), and
`GOOGLECALENDAR_EVENTS_LIST` returned **`items: []`** - a genuinely empty calendar, confirming this
is in fact a disposable TEST account with no personal or business data.

`scripts/poc/composio-calendar/event-roundtrip.ts` was added to attempt the remaining CREATE ->
GET -> DELETE -> cleanup steps. Before creating anything it independently re-verifies the
connection, tenant binding, scope/allowlist, and re-confirms the calendar is empty via its own
LIST call (fail-closed if any event already exists - not trusting the earlier confirmation alone).
All of that passed.

**`GOOGLECALENDAR_CREATE_EVENT` itself then failed - not from a permission, scope-drift, or
tenant-binding problem, but from a genuine Google API scope limitation surfaced live:**

```
HTTP 200 (Composio call succeeded) / successful: false
Google's own response: 403 PERMISSION_DENIED
reason: ACCESS_TOKEN_SCOPE_INSUFFICIENT
message: "Request had insufficient authentication scopes."
metadata.method: "calendar.v3.Calendars.Get"
url: https://www.googleapis.com/calendar/v3/calendars/primary
```

Composio's `GOOGLECALENDAR_CREATE_EVENT` action internally calls Google's `calendars.get`
endpoint (observable from the failing URL/method in the error, not something documented in the
tool's own input schema) - most likely to resolve calendar metadata such as the default timezone
before inserting the event. Google's `calendars.get` requires a broader Calendar OAuth scope
(`calendar` or `calendar.readonly`) than `calendar.events` provides; `calendar.events` covers
`events.*` operations only, not calendar-resource reads. This was re-tested with an explicit
`timezone: "UTC"` argument (ruling out "the tool falls back to a calendars.get call only when
timezone is omitted") - the identical 403 occurred either way, so the internal `calendars.get`
call appears unconditional in this action's implementation, not something any documented input
parameter can avoid.

**This is a real, load-bearing limitation of the `calendar.events`-only least-privilege scope this
PoC has used throughout, not a bug in this session's scripts or a caller-side error.**
`GOOGLECALENDAR_EVENTS_LIST` has now succeeded live three times under this exact scope;
`GOOGLECALENDAR_CREATE_EVENT` cannot succeed under it at all, regardless of arguments supplied,
because of a scope requirement inside Composio's own action implementation that sits outside the
four-tool allowlist's stated boundary. `GOOGLECALENDAR_EVENTS_GET` and `GOOGLECALENDAR_DELETE_EVENT`
remain **untested** (no event exists to GET/DELETE, and this session will not create one through
a different, unapproved path or widen scope to force CREATE through) - so whether they share this
same limitation is unknown, not assumed either way.

Per this task's explicit instruction not to widen OAuth scopes, this session did not attempt to
work around the 403 by requesting a broader scope. The calendar was left exactly as found (empty,
0 events) - the CREATE call failed before Google ever wrote anything, so no cleanup was needed. No
personal data is involved, since this account was confirmed empty before any attempt.

## Explicit, authorized least-privilege scope expansion: `calendar.events` + `calendar.calendars.readonly`

A follow-up task authorized determining and implementing the **minimum** additional OAuth scope
needed to fix the `calendars.get` gap above, explicitly forbidding the broad `calendar` scope
unless no narrower option could satisfy it.

**Verification against Google's own live API discovery document** (`GET
https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest`, fetched fresh - not memory, not
Composio's docs):

| Method                                                           | Accepted scopes (per Google, authoritative)                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `calendars.get`                                                  | `calendar`, `calendar.app.created`, `calendar.calendars`, `calendar.calendars.readonly`, `calendar.readonly` |
| `events.list` / `events.insert` / `events.get` / `events.delete` | each includes `calendar.events`                                                                              |

`calendar.events` is confirmed absent from `calendars.get`'s accepted list (explaining the live
403), and remains present for all four approved tools' own operations - no change needed there.
Of `calendars.get`'s accepted scopes, `calendar.app.created` only covers app-created resources (not
the pre-existing "primary" calendar, so it would not actually work) and `calendar.calendars` is
read+write (broader than a read-only `calendars.get` call needs). **`calendar.calendars.readonly`
is therefore the narrowest scope that both appears in `calendars.get`'s accepted list and would
actually function against the primary calendar** - confirming the task's proposed candidate scope
with fresh authoritative evidence, per its own Phase 1 requirement.

**Implementation**: `scripts/poc/composio-calendar/update-auth-config-scope.ts` (new) fails closed
unless the auth config's pre-update state is exactly the old single-scope baseline with the exact
4-tool execution allowlist (refusing to "expand" a config not in the exact state this evidence was
gathered against), then issues one `PATCH /api/v3.1/auth_configs/{id}` with `{ type: "default",
scopes: [calendar.events, calendar.calendars.readonly] }` - confirmed from the unpacked
`@composio/client` 0.1.0-alpha.76 SDK source that `scopes` is a **top-level** field on update for
`type: "default"` configs, not nested under `credentials` as at creation time. No
`tool_access_config` field was included, so the execution allowlist was left untouched per the
update endpoint's "only specified fields are updated" contract.

**Live result**: `HTTP 200`, re-read independently after the update shows scopes exactly
`[calendar.events, calendar.calendars.readonly]` and the execution allowlist unchanged (still
exactly the 4 approved tools, 0 missing/0 extra). `auth_config_id` (`ac_KIeGPcIy9Yo9`), tenant
binding, API key permissions, and registry status were not touched.

**A new OAuth grant is required for this scope change to take effect** - existing connected
accounts keep whatever scope they were originally granted under. `create-oauth-link.ts` was
updated to check for the new 2-scope set instead of the old single scope (its own pre-link
verification would otherwise now correctly, but no-longer-accurately, fail-close on every run).
One new link was created for the same TEST identity against the same auth config: a fourth
connected account, pending human OAuth completion with the confirmed-empty disposable Google test
account. Live consent-screen review and completion is a required human step before any further
CREATE attempt.

## Custom OAuth: Google blocked the managed client's request for the new scope

Opening the new link, Google returned a hard block - "This app is blocked. This app tried to
access sensitive info in your Google Account." - not the normal softer "unverified app" warning.
Research against current Google/Composio documentation confirmed why: Composio's shared managed
OAuth client is pre-configured (and Google-verified) for a **fixed** scope set per toolkit: "you
cannot request additional permissions" beyond what Composio itself has arranged. Requesting
`calendar.calendars.readonly` - outside that fixed set - was rejected by Google outright, not
because the scope itself universally requires full verification (Google's own docs confirm an app
in **Testing** publishing status with an explicit test user is exempt from verification for
sensitive scopes), but specifically because it's outside what Composio's own shared client is
authorized to ask for. Composio's own docs name this exact scenario ("you need custom scopes...
beyond the defaults") as the documented reason to switch to a customer-owned (bring-your-own
OAuth-app) auth config.

A Syveka-owned Google Cloud project, OAuth consent screen (External audience, **Testing** status,
the disposable Google test account added as a test user), and OAuth client were created by a
human outside this session (Google Cloud Console access isn't available to this session). A new
custom auth config (`ac_xJH5GAyq03KJ`, `syveka-poc-googlecalendar-custom-oauth`,
`is_composio_managed: false`) was created via Composio's dashboard using those credentials -
client_id/client_secret were entered directly into Composio's dashboard, never through this
session, never printed or committed.

**Two live-discovered setup defects, found by verification before any OAuth was attempted, both
fixed by the human (not by this session touching credentials):**

1. The new auth config's scopes were initially `["calendar", "calendar.events"]` - the full,
   forbidden `calendar` scope, apparently a dashboard default/leftover, and missing
   `calendar.calendars.readonly` entirely.
2. After a first dashboard edit, the scopes array became malformed: one element was
   `"calendar.events calendar.calendars.readonly"` (both scope URLs joined by a literal space
   inside one array entry - a paste artifact) plus a stray duplicate `"calendar.events"` entry.

This session declined to PATCH the fix itself once it determined that, unlike the earlier
`type: "default"` config, this `type: "custom"` config nests `scopes` inside `credentials`
alongside `client_id`/`client_secret` - a partial update risked replacing the whole `credentials`
object and wiping the working OAuth client secret, which this session can never read or resupply.
The human fixed both defects directly in the dashboard; each was re-verified read-only before
proceeding.

**Final live result** (connected account `ca_ZKv0PWsGs8J4`, TEST identity
`syveka:org-test-poc:user-test-poc`): `status: ACTIVE`, scopes exactly `[calendar.events,
calendar.calendars.readonly]` (cross-checked against both Composio's `requested_scopes` and
Google's own returned `scope` string), execution allowlist exactly the 4 approved tools.

- **LIST**: `HTTP 200`, calendar empty (0 events) - confirmed the connected Google account is a
  genuine disposable test account before any mutation was attempted.
- **CREATE** (`SYVEKA POC CALENDAR TEST`, 30 min, no attendees/recurrence/conferencing): succeeded
  live (`HTTP 200`, real event id, correct title/start/end) - **the first successful CREATE in
  this entire PoC**, proving the `calendar.calendars.readonly` scope fix actually resolves the
  `calendars.get` 403 that blocked every earlier attempt.
- **GET**: fetched the exact created event id; title and timestamps matched exactly.
- **DELETE**: succeeded (`response_data.status: "success"`); the calendar was left with 0 events.

One response-shape inconsistency was discovered along the way and is now handled generically (see
the hardening section below): `GOOGLECALENDAR_CREATE_EVENT` nests its result under
`data.response_data`, while `GOOGLECALENDAR_EVENTS_GET` returns the event flat under `data`, and
`GOOGLECALENDAR_DELETE_EVENT` returns `{ response_data: { status } }`.

## Production-oriented hardening: architecture overview

This section is the current, authoritative reference. Everything above is the evidence trail for
how these conclusions were reached; this section is what a new reader or a future integration
should start from.

### 1. Architecture

```
scripts/poc/composio-calendar/
  lib/
    security-contract.ts     - approved scopes/tools + fail-closed validators
    response-normalizer.ts   - CREATE/GET/LIST/DELETE -> one consistent shape
    calendar-service.ts      - CalendarService: listEvents/createEvent/getEvent/deleteEvent
    audit.ts                 - CalendarAuditLog: safe, secret-scrubbed operation records
    *.test.ts                - standalone tests for each module (no vitest, no network)
  tenant-binding.ts          - the real enforcement: connected_account_id resolved ONLY
                                from a server-verified (orgId, userId), never caller input
  tenant-binding.negative-test.ts - adversarial suite (11 cases, see Phase 4 below)
  create-oauth-link.ts, update-auth-config-scope.ts, ... - evidentiary/setup scripts (see README.md)
scripts/live-smoke/
  composio-calendar-smoke.ts - opt-in live roundtrip harness built on CalendarService
```

`CalendarService`'s public contract (`listEvents`/`createEvent`/`getEvent`/`deleteEvent`,
`TenantContext`, `NormalizedResult`) is not Composio-specific - a future provider swap needs a new
`ToolExecutor` implementation, not a caller-facing rewrite. `createComposioToolExecutor` is the
only place any of this code talks to the network.

### 2. Exact approved scopes

```
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendars.readonly
```

Enforced by `security-contract.ts`'s `checkScopes()`/`assertAuthConfigContract()`: fails closed on
the full `calendar` scope, any Gmail/Drive/Contacts scope, a missing scope, a duplicated scope, or
a malformed space-joined scope entry (all four defect shapes this PoC actually hit live).

### 3. Exact approved execution tools

```
GOOGLECALENDAR_CREATE_EVENT
GOOGLECALENDAR_DELETE_EVENT
GOOGLECALENDAR_EVENTS_GET
GOOGLECALENDAR_EVENTS_LIST
```

Enforced by `checkExecutionAllowlist()`/`assertToolApproved()`: fails closed on an empty
allowlist, a missing tool, or any extra/unapproved tool identifier (including tools from other
toolkits entirely).

### 4. Tenant-binding requirement

Every operation resolves its `connected_account_id` and Composio `entity_id` solely from a
server-verified `{ orgId, userId }` context, via `tenant-binding.ts`'s
`TenantComposioConnectionRegistry.findForTenant()` - the registry's only lookup path. Caller
input can never select a connection: `CalendarService`'s methods take a `TenantContext` and typed,
narrow operation inputs (`eventId`, `summary`, ...) that have no `connected_account_id` field to
smuggle a value through in the first place.

### 5. Custom OAuth requirement

A Google OAuth _application_ (Google Cloud project + consent screen + OAuth client), owned by
Syveka, is required for any Calendar scope beyond what Composio's shared managed client already
supports. Composio's managed auth remains viable for toolkits/scopes that fit its defaults; it
never becomes usable for this PoC's scope set no matter how the auth config is configured, because
the fixed scope ceiling lives on Composio's client registration in Google Cloud, not in anything
this repo controls.

### 6. Why Composio-managed OAuth was not sufficient

Composio's shared OAuth client is verified by Google for a fixed scope set per toolkit and cannot
request scopes outside it - confirmed by a hard "This app is blocked" response (not the softer
unverified-app warning) the moment `calendar.calendars.readonly` was requested through it. See
"Custom OAuth: Google blocked the managed client's request for the new scope" above.

### 7. Testing vs. Production distinction

The Syveka-owned OAuth app is in Google's **Testing** publishing status with the disposable test
Google account explicitly added as a test user - this exempts it from Google's full app
verification process entirely (confirmed via Google's own documentation), which is why the PoC
could proceed without that verification. **Before any real customer's Google account could use
this integration**, the OAuth app must move to a verified "In production" status: branding review,
domain ownership verification, a justification + demo video for the sensitive scope(s), and
ongoing compliance with Google's policies. Nothing in this repo does that automatically, and the
registry entry (`syveka-skills/core/registry/data.ts`, `status: "REVIEW"`) and the
`composioProvider` stub (`syveka-skills/providers/composio/index.ts`, always-unavailable) both
remain untouched by this hardening pass - Composio is still not production-routable.

### 8. Safe live smoke procedure

`scripts/live-smoke/composio-calendar-smoke.ts` runs LIST → CREATE → GET → DELETE against a real
connection, but:

- never runs automatically (not part of `npm test`, lint, typecheck, or CI)
- requires `LIVE_SMOKE_ENABLED=true` plus four more env vars naming the exact auth config,
  connected account, and TEST tenant identity - absent `LIVE_SMOKE_ENABLED=true` it prints a
  SKIPPED report and exits 0
- independently re-verifies the security contract and tenant binding, live, before any mutation
- aborts before CREATE if the calendar isn't already empty
- creates exactly one clearly-labeled disposable event (`SYVEKA LIVE SMOKE TEST — SAFE TO
DELETE`), no attendees/recurrence/conferencing (impossible to pass via `CreateEventInput`'s
  type, not just by convention)

### 9. Cleanup behavior

The harness's DELETE runs in a `finally` block: if CREATE succeeds but GET or anything after it
fails, cleanup of the exact created event id is still attempted before the process exits. It never
deletes any event id other than the one its own CREATE call returned - there is no discovery/lookup
path from title or time window back to an id.

### 10. Troubleshooting

| Symptom                                                                                | Cause                                                                                                                                                                                                                      | Fix                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HTTP 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` on CREATE, mentioning `calendars.get`       | `calendar.events` alone doesn't cover Google's `calendars.get` call that `GOOGLECALENDAR_CREATE_EVENT` makes internally                                                                                                    | Ensure the auth config's scopes include `calendar.calendars.readonly` (never the full `calendar` scope)                                                                                                                                    |
| `HTTP 403 APIKey_InsufficientPermissions`                                              | The `COMPOSIO_API_KEY` itself lacks a required permission (`auth_configs`/`connected_accounts`/`tool_execution`)                                                                                                           | Grant the specific missing permission to the key in Composio's dashboard - never widen further than that one gap                                                                                                                           |
| `HTTP 400 ActionExecute_ConnectedAccountEntityIdRequired`                              | Tool-execute calls require `entity_id` alongside `connected_account_id` (undocumented in the SDK types used to design this PoC)                                                                                            | Always send `entity_id` set to the connection's `composioUserId` (`CalendarService` does this automatically)                                                                                                                               |
| Google shows "This app is blocked" (not the softer unverified warning)                 | Requesting a scope outside what the Composio-managed shared OAuth client is itself verified/configured for                                                                                                                 | Switch to a customer-owned (custom) auth config with your own Google OAuth app - see sections 5-6 above                                                                                                                                    |
| Auth config's `scopes` array contains a value with a space in it, or a duplicate entry | A dashboard paste artifact - one field's value got joined instead of split into separate array entries                                                                                                                     | `security-contract.ts`'s `checkScopes()` will fail closed and name the exact malformed entry; fix it in the dashboard (do not PATCH a `type: "custom"` config's `credentials.scopes` via API - it risks wiping `client_secret`, see below) |
| A connection exists and is `ACTIVE`, but `assertTenantBindingContract` rejects it      | The connection's `user_id` is a Composio dashboard-generated placeholder (`pg-test-*`) or otherwise doesn't exactly match the expected `syveka:{orgId}:{userId}` string - "ACTIVE" alone is never sufficient               | Create a new OAuth link via `create-oauth-link.ts` (or `CalendarService`'s intended production equivalent) so the connection is created with the correct `user_id` from the start                                                          |
| `GOOGLECALENDAR_CREATE_EVENT`'s response looks different from `_GET`'s                 | Composio's per-tool response wrappers are inconsistent (CREATE nests under `data.response_data`, GET is flat under `data`, DELETE returns `{ response_data: { status } }`) - confirmed live, not documented anywhere       | Use `response-normalizer.ts` / `CalendarService` rather than parsing `data` directly in new code                                                                                                                                           |
| Editing a `type: "custom"` auth config's scope via the API seems risky                 | `scopes` lives nested inside `credentials` alongside `client_id`/`client_secret` for custom configs (unlike `type: "default"`, where `scopes` is top-level); a partial update might replace the whole `credentials` object | Edit custom auth config scopes via Composio's dashboard, not the API, unless you can verify the update endpoint deep-merges `credentials` without ever needing to resupply the secret                                                      |

### Phase 4 (this pass): tenant isolation + adversarial testing

`tenant-binding.negative-test.ts` re-run fresh: **11/11 PASS** (the original 8 plus 3 new cases
added this pass: a Composio dashboard `pg-test-*` placeholder identity is never accepted as a
tenant match; empty/missing org-or-user context fails closed; a third tenant's registration
cannot leak into two existing tenants' resolution). `security-contract.test.ts` separately covers
the tool-allowlist side of adversarial coverage (an unauthorized/unapproved tool identifier is
always rejected via `assertToolApproved`, regardless of what a caller requests).

### Response normalization + service layer + audit: test results (this pass)

All standalone, dependency-free, no network calls:

- `lib/security-contract.test.ts`: 22/22 PASS
- `lib/response-normalizer.test.ts`: 12/12 PASS (fixtures shaped after the actual live response
  bodies captured earlier in this document, not invented shapes)
- `lib/calendar-service.test.ts`: 10/10 PASS (mock `ToolExecutor`, including cross-tenant-leak and
  caller-cannot-smuggle-a-connection-id cases)
- `lib/audit.test.ts`: 8/8 PASS (redaction of both declared and undeclared secret-shaped fields,
  and `withAudit`'s success/failure/exception recording)

### Known limitations / remaining technical debt

- The live smoke harness (`scripts/live-smoke/composio-calendar-smoke.ts`) is implemented and
  validated (typecheck/lint/its own SKIPPED-path run) but was **not executed live** in this pass -
  a full manual roundtrip against `ca_ZKv0PWsGs8J4` was already completed earlier in this session;
  running the new harness immediately after would have created a second live event with no
  additional evidentiary value. It is ready to run on request.
- `GOOGLECALENDAR_EVENTS_GET`/`GOOGLECALENDAR_DELETE_EVENT`'s behavior against the
  Composio-managed auth config's scope-insufficiency case was never directly observed (only
  CREATE was), since no event could ever be created under that config to GET/DELETE.
- Production readiness still requires: moving the Syveka OAuth app out of Testing status (full
  Google verification), a GDPR/privacy review of Composio as a subprocessor, and a deliberate
  decision to change the registry's `status`/`integration_state` - none of which this pass
  touches.

## Post-rotation hardening pass

Both the `COMPOSIO_API_KEY` and the Google OAuth Client Secret were rotated by a human outside
this session (old key revoked; new client secret updated in Composio). Neither value - old or new

- was ever printed, logged, or committed. The new key was independently verified via a read-only
  Composio API call (not a Calendar tool) before this pass began.

**Secret-safety audit (this pass)**: full branch diff scanned for API keys, client secrets, access/
refresh tokens, Authorization/Bearer values, and OAuth link tokens. One real finding: an earlier
commit had recorded a live OAuth connection link (`https://connect.composio.dev/link/lk_...`) in
this document's own Phase-2-live-result narrative. The link itself was single-use and had already
been consumed (the same paragraph describes a human completing OAuth with it) and its `expires_at`
had long since passed, so it carried no live exposure risk - but committing any link-token value to
tracked docs is against this project's own secret-hygiene standard, so it has been redacted here.
No other instance was found anywhere in the branch. `.env.local` remains untracked/gitignored;
`.env.example` carries no real value.

**Security-contract hardening**: two real gaps closed, each backed by a new test.

- `assertAuthConfigContract` gained an optional `expectedAuthConfigId` check: an auth config whose
  scopes/allowlist look perfectly compliant is still rejected if it isn't literally the specific
  config the caller expected - closing a "right-shaped but wrong identity" gap that the original
  version didn't check for.
- `checkScopes` was already correct but under-tested for a _generic_ unapproved extra scope (e.g.
  `calendar.settings.readonly` - a real, valid Google Calendar scope that simply isn't one of the
  two approved ones, distinct from the Gmail/Drive/Contacts/full-calendar cases already covered).

**CalendarService hardening**: `listEvents` previously bounded the _time window_ but not the
_result count_ - `GOOGLECALENDAR_EVENTS_LIST`'s own schema was checked live (read-only) and
confirmed a `maxResults` parameter (Google's own ceiling: 2500, default 250 if unspecified).
`ListEventsInput` now accepts an optional `maxResults` (service default: 100) and rejects any value
above Google's own ceiling before ever calling the tool - "no accidental unbounded historical
fetch" now covers result count, not only the date range.

Separately, `execute()` previously let a thrown transport-level error (network failure, timeout,
DNS) propagate as an uncaught rejection, inconsistent with every other failure mode already
resolving to a safe `{ success: false }` result. It's now caught and reshaped into the same
`ToolExecutorResponse` failure shape (`status: 0`), which `response-normalizer.ts` classifies as
`TRANSPORT_ERROR` - callers can rely on `result.success` alone to branch safely in every case, not
just HTTP-level failures.

**Test counts after this pass** (all standalone, dependency-free, zero network calls):

| Suite                             | PASS      |
| --------------------------------- | --------- |
| `tenant-binding.negative-test.ts` | 11/11     |
| `lib/security-contract.test.ts`   | 25/25     |
| `lib/response-normalizer.test.ts` | 13/13     |
| `lib/calendar-service.test.ts`    | 14/14     |
| `lib/audit.test.ts`               | 8/8       |
| **Total**                         | **71/71** |

**Live smoke decision: not executed.** The rotated `COMPOSIO_API_KEY` was already verified via a
read-only call; the Google Calendar OAuth connection (`ca_ZKv0PWsGs8J4`) was already proven live
end-to-end (LIST/CREATE/GET/DELETE, PASS) before rotation. Rotating a Google OAuth client's secret
does not invalidate previously-issued refresh tokens under standard OAuth 2.0 semantics - Google's
token endpoint validates whatever secret is presented against its own currently-registered value
for that client_id, not the secret in effect when the token was originally issued - so the existing
connection should remain functional without any new live check. A full CREATE/GET/DELETE roundtrip
would add no new evidence over what's already proven, so none was run; the harness remains in its
default SKIPPED state. One narrower, genuinely open (but low-probability) question remains: whether
Composio's _stored_ copy of the new secret actually enables a successful token refresh against
Google - this could be resolved with a single read-only LIST call if a human wants that specific
confirmation, but this session did not run one unprompted, per this task's explicit instruction not
to execute Calendar operations automatically.
