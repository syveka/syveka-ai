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
  `redirect_url = https://connect.composio.dev/link/lk__rVb5IFKztzI`,
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
