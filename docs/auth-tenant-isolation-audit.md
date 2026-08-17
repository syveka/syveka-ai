# Authentication and tenant-isolation audit

Date: 2026-08-14

Starting revision: `2df641df66207f2a1bfa26ba272e715c842c6263` (`origin/main`)

Scope: server authentication, authorization, organization scoping, privileged database access,
public and signed endpoints, background jobs, record ownership, and soft-deleted tenants.

## Executive summary

The normal signed-in application path is fail-closed: Supabase `getUser()` establishes identity,
`getTenantContext()` resolves a live database membership and rejects a soft-deleted organization,
`requirePermission()` applies the central five-role matrix, and `tenantDb(orgId)` injects the
organization constraint into the 36 directly tenant-owned Prisma models. RLS is a defense for
Supabase-native access, not the application Prisma connection, which can bypass it. Consequently,
every `unscopedPrisma` use remains a security boundary.

This review confirmed four related P1 classes of tenant-integrity defects. A calendar OAuth state
remained usable after the initiating administrator lost access; calendar attendee `userId` values
were not checked against membership; workflow run/resume and notification recipients were not
fully bound to their organization; and three provider-webhook lookups continued resolving resources
for soft-deleted organizations. All are fixed without a schema change or new dependency. No P0
authentication bypass was found.

The Stripe webhook route, its event ledger and its tests were deliberately not modified or rebased:
they are owned by concurrent PR #72. This is a coordination exception, not a statement that the
concurrent implementation was re-audited here.

## Threat model

Relevant attackers are an unauthenticated internet client, a valid user from another tenant, a
current low-privilege member, a recently revoked or downgraded member holding an expiring OAuth
state, and a caller able to deliver a correctly signed provider/job payload. The protected assets
are tenant records, integration credentials, notifications, object paths, privileged mutations and
the non-enumerability of foreign identifiers. The review assumes cryptographic signing keys remain
secret; production key rotation and provider-console settings require configuration verification.

## Boundary inventory

| Entry point                                                                                       | Authentication                                                                     | Authorization                                                                                                    | Tenant scope and data path                                                                                                     | Failure behavior                                                                      | Coverage                                                                            |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Localized protected pages/layouts                                                                 | Middleware cookie-presence hint, then Supabase `getUser()` in server code          | Page/service permission as applicable                                                                            | Live `OrganizationMember` lookup; rejects `Organization.deletedAt`                                                             | Redirect/null context; middleware is UX only and is not trusted as auth               | session, middleware, permissions, CSP tests                                         |
| Auth actions                                                                                      | Supabase password, magic-link or recovery APIs                                     | Provider-owned auth policy                                                                                       | No tenant data before identity; organization creation establishes owner membership transactionally                             | Provider-safe error/redirect                                                          | auth/onboarding tests                                                               |
| Organization switch                                                                               | Supabase session user                                                              | Explicit membership lookup                                                                                       | User + requested organization membership; subsequent context again rejects deleted org                                         | Generic membership error                                                              | action and session coverage; deleted-org switch is a usability residual noted below |
| CRM, inbox, calendar, booking-management, knowledge, prompt, voice, workflow and settings actions | `requirePermission()` or `getTenantContext()` for user-owned profile/notifications | Central permission matrix; destructive actions use narrower permissions                                          | `tenantDb(ctx.orgId)` plus parent checks for child models                                                                      | Missing and foreign records generally collapse to not-found; guard errors fail closed | broad unit service/action coverage, focused negative tenant tests                   |
| `/api/v1/ai/chat`, files and upload intent                                                        | Supabase session                                                                   | `chat:use` / knowledge write permission; rate limits on ingestion                                                | Conversation/document/upload-intent ownership includes org and user where required; storage keys are server-derived            | 401/403/404 or safe validation error                                                  | chat/files/upload-intent tests                                                      |
| `/api/v1/business-dna`, extraction                                                                | Supabase session                                                                   | read/write permission; extraction rate limit                                                                     | tenant service                                                                                                                 | Safe auth/validation error                                                            | Business DNA RBAC tests                                                             |
| `/api/v1/inbox` list/detail                                                                       | Supabase session                                                                   | inbox read                                                                                                       | tenant-scoped thread/message service                                                                                           | foreign and missing thread do not disclose tenant existence                           | inbox service/route tests                                                           |
| Public booking type/slots/create                                                                  | Public; rate limited                                                               | Capability is active public booking URL                                                                          | Organization slug + type slug + active/non-deleted type + non-deleted organization                                             | not-found/validation without foreign IDs                                              | booking service and route tests                                                     |
| Booking manage token                                                                              | High-entropy bearer token; rate limited                                            | Token hash, expiry and use state                                                                                 | Token resolves its booking through server data, not a supplied org ID                                                          | invalid/expired tokens collapse to safe errors                                        | booking token tests                                                                 |
| Calendar OAuth callback                                                                           | HMAC state bound to org, user, provider and 10-minute expiry                       | **Now** revalidates live membership, active org and `integrations:manage` before exchange and before persistence | Unscoped connection/calendar upserts use only the revalidated state scope                                                      | revoked, downgraded, deleted and malformed states all return `bad_state`              | new callback freshness tests                                                        |
| Calendar provider webhook                                                                         | Provider subscription id + per-subscription hashed secret                          | Exact provider/subscription pair                                                                                 | **Now** relation query requires active organization before sync                                                                | unknown, deleted and bad-secret cases all return false                                | calendar webhook and sync tests                                                     |
| Inbox generic/Resend webhooks                                                                     | Shared secret or Svix signature; rate limited                                      | Verified mailbox address determines tenant                                                                       | Mailbox lookup never trusts payload org; **now** requires active organization                                                  | unknown/deleted mailbox is non-enumerating                                            | inbox mailbox/webhook tests                                                         |
| Vapi webhook                                                                                      | Vapi signature                                                                     | restricted service identity and enabled-tool allowlist                                                           | Assistant lookup derives org; **now** requires active organization                                                             | invalid signature 401; unknown/deleted assistant 404                                  | voice webhook tests                                                                 |
| QStash job endpoints                                                                              | QStash current/next signing keys                                                   | Job-specific resource validation                                                                                 | Jobs bind record IDs to payload org. Workflow resume now binds run + workflow + org; notification writes revalidate membership | invalid signature 401; stale/mismatched work is skipped or not found                  | job tests plus new workflow security tests                                          |
| `/api/health`                                                                                     | Public by design                                                                   | none                                                                                                             | Returns only coarse dependency status, not records or credentials                                                              | degraded status without exception details                                             | health tests                                                                        |
| API-key management actions                                                                        | Supabase session                                                                   | `api-keys:manage`                                                                                                | tenant-scoped key rows; raw key only returned at creation                                                                      | guarded errors                                                                        | API-key service/action coverage                                                     |
| Stripe webhook                                                                                    | Stripe signature in starting main                                                  | Concurrent PR #72 owns reliability changes                                                                       | Excluded from edits and conclusions in this branch                                                                             | unchanged                                                                             | PR #72-owned tests/checks                                                           |
| Supabase PostgREST/Storage/Realtime                                                               | Supabase JWT                                                                       | SQL RLS/storage policies                                                                                         | Organization/user claims in policies                                                                                           | database denial                                                                       | RLS structure, isolation and non-superuser tests                                    |

The API directory contained 26 routes at the starting revision: one public health route, 12
session/public-capability product routes, one OAuth callback, six signed jobs, and six provider
webhooks (including Stripe). Every route was classified above. All server-action exports under
`src/actions` were traced to authentication/permission entry points and their service calls.

## Confirmed vulnerabilities

### A-01 — stale calendar OAuth authorization (P1, high)

- Path: `connectCalendarAction` → signed state → calendar callback → `completeConnection()` →
  provider token exchange → unscoped connection/calendar upserts.
- Preconditions: an admin/owner begins OAuth, then is removed or downgraded, or the organization is
  soft-deleted, before the callback completes.
- Abuse/failure: the still-valid HMAC state authorized storage of new third-party credentials and
  calendar metadata for a tenant the user no longer controls.
- Existing protection: state signature, provider binding and ten-minute expiry prevented forgery,
  but did not express current authorization.
- Evidence: the old callback performed no membership or role query. Regression tests cover revoked,
  downgraded, mid-flow-revoked and authorized-admin cases.
- Remediation: re-read active membership and apply the central permission matrix before exchanging
  the code and again immediately before persistence. All failures collapse to `bad_state`.
- Rejected alternative: encoding role in the state would merely sign another stale fact. A database
  transaction cannot safely enclose an external OAuth exchange. The two checks minimize the race;
  a very small revocation race between the final check and upsert remains.

### A-02 — cross-tenant calendar attendee user reference (P1, high)

- Path: calendar write action → `createEvent`/`updateEvent` → `syncAttendees()` → unscoped
  `EventAttendee.createMany()`.
- Preconditions: a member with `calendar:write` knows or guesses another platform user's UUID.
- Abuse/failure: `EventAttendee.userId` accepted an arbitrary UUID; the schema has neither a User
  relation nor an organization-membership constraint. A tenant event could therefore carry a
  cross-tenant user reference.
- Existing protection: attendee contact IDs and event ownership were checked, but attendee user IDs
  were not.
- Evidence: code-path inspection plus a focused negative test that would previously reach the write.
- Remediation: count unique attendee user IDs through tenant-scoped `OrganizationMember` before any
  event or child write. Foreign and missing users receive the same `invalid_relation` result.
- Rejected alternative: adding a plain User foreign key would not prove tenant membership. A
  composite database invariant would require a larger schema/migration design.
- Residual risk: parent and attendee writes are still separate operations after validation; a
  database transaction could improve general atomicity but is outside this narrow isolation fix.

### A-03 — workflow cross-tenant run and notification references (P1, high)

- Path: workflow save or signed run job → `notify.member`/resume → unscoped WorkflowRun and
  Notification writes.
- Preconditions: a workflow manager supplies another user's UUID, a recipient/creator is later
  revoked, or a valid signed job contains a run ID belonging to a different workflow/tenant.
- Abuse/failure: workflow definitions could persist a foreign notification target; execution wrote
  organization/user pairs without current membership; resume updated `WorkflowRun` by ID alone.
- Existing protection: workflow lookup was scoped by workflow + org and the job required QStash
  signature. Those controls did not bind the secondary IDs.
- Evidence: direct query inspection and focused tests for foreign run, foreign configured recipient,
  revoked runtime recipient, revoked failure-recipient, and valid member.
- Remediation: validate explicit recipients at save time, revalidate active membership at execution,
  suppress failure notifications after creator revocation, and resolve resumed runs by run + workflow
  - organization before updating.
- Rejected alternative: validator-only UUID syntax or trusting signed internal payloads does not
  establish ownership. A new database relation/migration was unnecessary for the verified paths.
- Residual risk: arbitrary external email recipients are an intended workflow feature and require
  product-level abuse controls rather than tenant-ID validation.

### A-04 — provider ingress continued for soft-deleted organizations (P1, medium)

- Paths: inbox recipient lookup, calendar subscription lookup and Vapi assistant lookup.
- Preconditions: the tenant was soft-deleted while provider identifiers/secrets remained active and
  a correctly signed provider delivery arrived.
- Abuse/failure: new messages, sync work or voice-call processing could continue under a deleted
  tenant, consuming resources and extending retained data.
- Existing protection: provider signatures/secrets and server-derived org IDs prevented spoofing.
- Evidence: none of the three relation lookups constrained `Organization.deletedAt`; focused tests
  now assert the active-organization predicate and no downstream write/sync.
- Remediation: add relation-level `deletedAt: null` predicates at the first unscoped lookup. Preserve
  non-enumerating unknown-resource responses.
- Rejected alternative: relying on eventual provider deprovisioning is fail-open when cleanup fails.
- Residual risk: already queued non-workflow jobs may finish after soft deletion. Defining universal
  cancellation semantics needs a separate lifecycle design and was not broadened into this patch.

## Defense-in-depth observations and non-issues

- Middleware only checks for a Supabase cookie and excludes `/api`; this is intentional routing UX.
  Server guards call Supabase `getUser()` and are the actual trust boundary.
- `getTenantContext()` uses the live membership role rather than trusting a role claim. Revoked
  membership and soft-deleted organizations fail closed even when the session cookie remains.
- `tenantDb` now has an automated model-coverage test, closing prior allowlist-drift risk. Parent-only
  models still require service-level checks, as demonstrated by A-02.
- `getFreshTokens(connectionId, orgId)` already filters by both identifiers and has regression tests;
  the historical connection-ID-only concern is no longer present.
- Public booking lookup already requires both booking type and organization to be active/non-deleted.
- File upload intents bind organization, user, path prefix, expiry and one-time use. Document reads and
  deletes resolve storage paths from tenant-scoped records rather than accepting arbitrary object keys.
- Foreign and missing record IDs generally use the same `findFirst`/not-found behavior. No route was
  found that intentionally reveals which other tenant owns a supplied ID.
- Authentication, signature and audit failures are fail-closed where they establish access. Audit
  logging is intentionally best-effort so logging availability does not change the authorization
  result. Redis rate-limit degradation should continue to be monitored as an availability/security
  tradeoff, but no tenant bypass was found through it.
- `tenantDb.upsert()` does not inject organization ID into create/update payloads. No current business
  call uses tenant-scoped upsert, so this is not presently exploitable; future use needs a contract
  test or extension hardening first.

## Production configuration verification

The following cannot be proven from repository code and must be checked without exposing values:

- Supabase custom-access-token hook enabled and RLS/storage policies deployed at the expected hashes.
- Application Prisma role remains deliberately separated from the non-superuser RLS test role.
- QStash current/next keys, Vapi secret, Resend/Svix secret, calendar OAuth state secret and provider
  callback secrets are configured, rotated and scoped to the correct environment.
- Provider consoles use the exact production callback URLs and stop deliveries during tenant
  deprovisioning; webhook retry/DLQ monitoring is active.
- Vercel environment separation and preview protection do not expose production credentials.
- API-key consumption is not yet exposed as a public API route in this revision; management controls
  were reviewed, but future bearer-auth endpoints require a separate end-to-end scope audit.

No secret values, production data, external services or production databases were accessed during
this audit.
