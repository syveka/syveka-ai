# Creator Studio v1

AI character → image → video → caption → approval → schedule → publish → analytics, built on top of
Syveka's existing tenant/RBAC/billing/job/storage infrastructure rather than a parallel stack. This
document is the technical reference for the feature; it does not set policy — see `CLAUDE.md` for that.

## 1. Status (read this first)

Creator Studio v1 is a **real, working foundation with real image/video generation, real Instagram/
Facebook publishing, and TikTok/YouTube still mocked/blocked pending a separate mission**. Concretely:

- **Real**: tenant-scoped schema + RLS (including live RLS tenant-isolation verification — §13), RBAC,
  the credit reserve/commit/release ledger, the approval state machine, autopilot rule evaluation, the
  scheduling/publishing engine (idempotent claim, retry-safe), caption generation (calls the real
  Anthropic integration), audit logging, notifications, FI/EN/AR i18n (RTL-correct), the full UI flow —
  **and now**: image/video generation via fal.ai (FLUX + Kling — §7), and Instagram/Facebook publishing
  via the real Meta Graph API, including OAuth, token refresh, idempotent scheduled publish, retries, and
  audit logs (§8).
- **Config-gated, not code-gated**: both real providers above fall back to their mock implementation
  automatically whenever their credentials (`FAL_API_KEY`; `META_APP_ID`/`META_APP_SECRET`) are unset —
  the same code path runs in dev/CI (mocked, free, deterministic) and production (real, once configured),
  with no separate code branch to keep in sync.
- **Still mocked/blocked**: TikTok and YouTube publishing (`blocked-adapter.ts`) — out of scope for this
  pass by explicit product direction; only their `SocialPublishingProvider` interfaces are preserved so a
  future mission can implement them the same way Instagram/Facebook were.

Every provider layer is deliberately **interface-complete**: swapping in a further provider (e.g. a
premium video vendor, or TikTok/YouTube) means writing one new adapter class and registering it in a
router, not touching any calling code — see §12.

Behind the `creator_studio_v1` feature flag (§9) — disabled by default for every organization.

## 2. Domain model

New Prisma models (migration `20260908000000_creator_studio_v1`):

- `CreatorProfile` — an AI character. `consentConfirmedAt` gates generation; `status` DRAFT→ACTIVE.
- `CreatorReferenceAsset` — both uploaded training images (`source: UPLOAD`) and generated output
  (`source: GENERATED`) — this doubles as the generic "media asset" table the repo didn't already have.
- `CreatorTemplate` — global (`organizationId: null`, seeded — see `prisma/seed.ts`) or org-owned prompt
  templates. Reads merge both via `unscopedPrisma`, same pattern as `Prompt` (§15.7 of the main charter).
- `CreatorGeneration` — one row per AI call: type, provider/model, credits reserved/consumed, output
  (`outputAssetIds` for media, `output` JSON for captions), status, sanitized error.
- `CreatorCampaign` — objective, target platforms/languages, `approvalMode`
  (MANUAL/APPROVAL/AUTOPILOT), `autopilotEnabled` + `autopilotRules` JSON.
- `CreatorPost` — a publishable item: assets, caption, `approvalStatus`, `contentVersion` /
  `approvedContentVersion` (see §5), `publishStatus`, `scheduledFor`, `externalPostId`.
- `SocialAccount` — a connected publishing destination; `accessTokenEnc`/`refreshTokenEnc` are
  AES-256-GCM ciphertext (§8), never returned to the client (`omitTokens()` in
  `creator-social-accounts.ts`).
- `CreatorCreditBalance` / `CreatorCreditTransaction` / `CreatorCreditGrant` — the credit ledger (§4).

All tenant-scoped models are registered in `TENANT_MODELS` (`src/server/db/tenant.ts`) and get generic
RLS CRUD policies (`creator_profiles`, `creator_campaigns`, `creator_posts`) or select-only client
policies (`creator_generations`, `creator_templates`) in the migration SQL. `creator_reference_assets`,
`social_accounts`, and the three credit tables intentionally have **no client RLS policy** — same
rationale as `document_upload_intents`/`calendar_connections`: token material and balance mutation must
only ever go through the audited, rate-limited service layer.

## 3. Request flow

Same layering as the rest of the app: `src/server/services/creator-*.ts` hold all business logic;
`src/app/api/v1/creator-studio/**/route.ts` (external/API callers) and `src/actions/creator-studio.ts`
(Server Actions, used by the UI) are both thin transport layers over those same functions. Every
mutating route/action: `requirePermission(...)` → rate limit → zod validate → service call → typed JSON.

Services: `creator-profiles`, `creator-templates`, `creator-generations`, `creator-campaigns`,
`creator-posts`, `creator-social-accounts`, `creator-publishing`, `creator-analytics`, `creator-credits`,
`creator-notifications`, `feature-flags`.

## 4. Credit system

`src/server/services/creator-credits.ts`. Server-side-only reserve → commit/release ledger, separate from
`UsageRecord` metering.

- `getCreatorGenerationCreditCost(type, provider, model, options)` is the **single** place pricing is
  computed — base cost per `CreatorGenerationType`, a per-provider multiplier (so a future real vendor
  registers its own multiplier without touching calling code), a quality multiplier, and a duration
  multiplier for video. Never hardcode a cost anywhere else.
- Balances live in `CreatorCreditBalance` (`availableCredits`, `reservedCredits`). Reserve/commit/release
  mutate it via an **atomic conditional `UPDATE`** — e.g. reserve does
  `WHERE organizationId = $1 AND availableCredits >= $amount`, checks `count === 1`. Postgres serializes
  concurrent updates to the same row, so two simultaneous reservations against a balance that can only
  cover one of them can never both succeed — no read-then-write race, no need for `SELECT ... FOR UPDATE`.
- Every reserve/commit/release/grant writes a `CreatorCreditTransaction` row (append-only).
- Monthly grants are plan-based (`PLAN_LIMITS[plan].creatorCreditsPerMonth` in
  `src/server/services/billing/plans.ts`) and idempotent per (org, calendar month) via a unique
  constraint on `CreatorCreditGrant` — safe to call `ensureMonthlyCreditGrant` on every balance read.
- `requestCharacterImageGeneration` / `requestImageFromCharacterGeneration` /
  `requestVideoFromImageGeneration` / `requestCaptionGeneration` (`creator-generations.ts`) all funnel
  through one `runGeneration()` helper: create QUEUED row → reserve → GENERATING → provider call →
  COMPLETED + commit, or FAILED + release + a **sanitized** error message (raw provider errors are logged
  server-side via `console.error`, never persisted to a client-reachable field).

## 5. Approval workflow

`src/server/services/creator-posts.ts`. `CreatorPost.approvalStatus`:
`DRAFT → PENDING_APPROVAL → APPROVED | REJECTED | CHANGES_REQUESTED`.

- `requestPostApproval` notifies every OWNER/ADMIN/MANAGER (`notifyApprovers`).
- `reviewCreatorPost({decision})` requires `creator:approve`. Approving stamps
  `approvedContentVersion = contentVersion` — the post is approved **for that exact content**, not
  forever.
- `updatePostContent` bumps `contentVersion` and resets `approvalStatus` to `PENDING_APPROVAL` **only**
  if the post was already `APPROVED` — editing a draft doesn't need re-approval, editing approved content
  does (Phase 10's "material edit invalidates approval").
- The publishing engine (§6) re-checks `approvalStatus === "APPROVED" && approvedContentVersion ===
contentVersion` immediately before publishing — approval granted when scheduling is never trusted
  blindly at publish time.

Three campaign approval modes (`CreatorCampaign.approvalMode`): `MANUAL` (generate only, customer
publishes elsewhere), `APPROVAL` (default — the flow above), `AUTOPILOT` (§6).

## 6. Scheduling & publishing engine

`schedulePost()` (`creator-posts.ts`) records `scheduledFor`/`socialAccountId`, sets `publishStatus:
SCHEDULED`, and enqueues a QStash job (`publish-creator-post`, `src/server/jobs/queue.ts`) with
`delaySeconds` computed from `scheduledFor` and a `deduplicationId` scoped to
`postId:contentVersion`.

`publishCreatorPost(orgId, postId)` (`src/server/services/creator-publishing.ts`, invoked by
`/api/v1/jobs/publish-creator-post`) is the **only** place `SocialPublishingProvider.publishPost` is ever
called. On every invocation, in order:

1. Resolve the post **scoped to `organizationId`** (tenant ownership, never trusted from the job payload
   alone beyond that filter).
2. **Idempotent claim**: `UPDATE ... WHERE publishStatus IN ('SCHEDULED','FAILED')` → `PUBLISHING`,
   checking `count === 1`. A concurrent/duplicate QStash delivery that loses the race is a silent no-op —
   never a double-publish. A `FAILED` post is reclaimable, which is how retries work.
3. Re-verify: not canceled/rejected; approval (or, for an autopilot campaign, `evaluateAutopilotRules` —
   platform allow-list, publishing-hour window, weekly/monthly caps, all violations reported by name);
   the social account is `CONNECTED` with token material present; every referenced asset exists.
4. Call the provider, persist `externalPostId`, mark `PUBLISHED`, audit, notify.
5. On any failure: mark `FAILED` with a **sanitized** `lastErrorSafe` (raw errors go to
   `console.error` only), audit, notify, then re-throw so the job handler returns 5xx and QStash's
   built-in bounded retry (3 attempts, set at enqueue time) can retry a transient failure. No credits are
   consumed by publishing — only generation reserves/spends credits, matching Phase 2's guidance that
   publishing itself doesn't need to.

## 7. AI generation providers

`src/server/ai/creator/` — `CreatorMediaProvider` (`generateCharacterImage`,
`generateImageFromCharacter`, `generateVideoFromImage`) and `CreatorCaptionProvider`
(`generateCaption`), resolved independently via `getCreatorMediaProvider()` /
`getCreatorCaptionProvider()` (`src/server/ai/creator/index.ts`) so a capability's provider can change
without touching the other.

- **Media, real**: `FalCreatorMediaProvider` (`fal-provider.ts`) — fal.ai's queue API
  (`src/server/integrations/fal.ts`), chosen for cost-efficient, production-capable image/video generation
  without a dedicated enterprise contract. FLUX (`fal-ai/flux/schnell` text-to-image,
  `fal-ai/flux/dev/image-to-image` for reference-guided generation) for images; Kling
  (`fal-ai/kling-video/v1.5/standard/image-to-video`) for video. Reference assets are read via a
  short-lived signed Supabase Storage URL; fal.ai's output is downloaded and re-uploaded into the org's
  own `creator-generated-media` bucket rather than keeping a third-party CDN link. Model names are
  overridable per-deployment via `FAL_IMAGE_MODEL`/`FAL_IMAGE_TO_VIDEO_MODEL`.
  **Known, disclosed limitation**: this does not perform identity-locking / LoRA-style
  character-consistency conditioning — `generateImageFromCharacter` uses one reference image only as an
  image-to-image style/composition guide, not a face-identity lock. A per-character LoRA or IP-Adapter
  pipeline would be needed for true consistent-character generation; out of scope for this pass.
- **Media, routing**: `src/server/ai/creator/router.ts` resolves `mock` vs `fal` (future: a premium
  provider, e.g. Veo) per-capability, auto-detecting `fal` once `FAL_API_KEY` is set, or pinned explicitly
  via `CREATOR_MEDIA_PROVIDER=mock|fal`. Adding a further provider is registering it in this router's
  `PROVIDERS` map — see §12.
- **Caption**: `ClaudeCaptionProvider` (`caption-provider.ts`) — a real call through the platform's
  existing `streamClaude()` (`src/server/integrations/anthropic.ts`), `routeModel("draft")`. Prompts the
  model for strict JSON (`{primary, short, cta, hashtags}`), reuses `getBusinessDnaContext` +
  `buildBusinessDnaPromptBlock` for brand-voice grounding (with the existing prompt-injection wrapping).
  Tests mock `streamClaude` — this must never make a live call in CI.
- **Credit cost**: `PROVIDER_COST_MULTIPLIER` in `creator-credits.ts` gives `fal` a higher multiplier than
  `mock` so an org's credit grant roughly tracks real fal.ai spend — the only place a new real provider's
  pricing is registered.

## 8. Social publishing providers

`src/server/social/` — `SocialPublishingProvider` (`connectAccount`, `refreshConnection`, `publishPost`,
`getPublishStatus`, `revokeConnection`), one instance per `SocialPlatform` via
`getSocialPublishingProvider(platform)`.

- **Instagram + Facebook, real**: `InstagramPublishingProvider` / `FacebookPublishingProvider`
  (`meta-provider.ts`) — the real Meta Graph API (`src/server/integrations/meta/client.ts`), gated on
  `META_APP_ID`/`META_APP_SECRET`. One Meta app covers both platforms: a user authorizes once via the
  standard OAuth code flow (`src/app/api/v1/creator-studio/social-accounts/oauth/meta/callback`,
  `src/server/social/oauth-state.ts` for the HMAC-signed, expiring, tenant-bound `state` — the same
  pattern as the existing calendar OAuth callback, no session cookie trusted), and the adapter discovers
  the user's Facebook Pages (and, for Instagram, the linked professional account) to connect the first
  eligible one per platform.
  - **OAuth/token handling**: authorization-code exchange → long-lived (~60 day) token exchange → Page
    discovery. `refreshConnection()` re-derives a fresh Page token from the stored long-lived user token,
    since Meta has no separate `refresh_token` grant.
  - **Publishing**: Facebook photos publish synchronously (`/​{page-id}/photos`); Instagram media use the
    two-step container-create → poll-until-`FINISHED` → publish flow, bounded to ~2 minutes. Both fetch
    media by a signed URL the publishing engine prepares (see below) rather than accepting an upload body.
  - **Known, disclosed limitation**: `connectAccount()` always connects the first eligible Page/Instagram
    account — there is no in-flow picker for an org managing several Pages (the
    `SocialPublishingProvider.connectAccount(authCode)` interface returns exactly one connection). Such an
    org must disconnect/reconnect to switch which Page publishes.
- **Approval checks, scheduling, idempotency, retries, audit logs, safe failures**: all already enforced
  by the provider-agnostic publishing engine (§6) — real providers plug into the same guard chain with no
  changes needed there.
- **Asset delivery**: `SocialPublishRequest.assetUrls` — the publishing engine
  (`creator-publishing.ts`) signs each asset's URL from the correct bucket (`UPLOAD` → reference bucket,
  `GENERATED` → generated-media bucket) before calling `publishPost`; a provider never signs storage URLs
  itself.
- `MockSocialPublishingProvider` (`mock.ts`) — used for TikTok/YouTube (still blocked, see below) and for
  Instagram/Facebook whenever the real adapter reports `isConfigured() === false`, as long as either
  `NODE_ENV !== "production"` or `CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1` is set; otherwise
  `getSocialPublishingProvider` throws rather than silently no-op-publishing in production.
- **TikTok + YouTube, still blocked** (`blocked-adapter.ts`): `TikTokPublishingProvider` /
  `YouTubePublishingProvider` implement the full interface and every method throws
  `SocialProviderNotImplementedError`, with a `blockedReason` string naming exactly what's missing (app
  registration, API review, OAuth credentials) — deliberately not implemented in this pass; see §12 for
  what each needs when that mission is picked up.
- Tokens: `src/server/integrations/social/crypto.ts`, AES-256-GCM, its own `SOCIAL_TOKEN_ENCRYPTION_KEY`
  (separate from the calendar integration's key — §4 of the charter: validate each integration's config
  independently). Ciphertext only ever lives in `SocialAccount.accessTokenEnc`/`refreshTokenEnc`;
  `listSocialAccounts`/`connectSocialAccount`/`disconnectSocialAccount` all strip those fields before
  returning (`omitTokens()`).

## 9. Feature flags

No dedicated feature-flag table exists in this codebase yet (confirmed by the repo audit before starting
this work). `src/server/services/feature-flags.ts` repurposes `Organization.settings` (already a generic
per-org JSON bag) rather than building new infrastructure for two flags:

- `creator_studio_v1` — gates the entire feature (checked in the layout and every service call).
- `creator_studio_autopilot` — gates _enabling_ autopilot specifically (`setCampaignAutopilot`), so an
  org can use manual/approval-mode Creator Studio while autopilot stays off, and a platform admin can
  kill autopilot without touching the rest of the feature.

A dedicated flag table/service is the natural next step if a third flag or gradual rollout percentages
are ever needed — deliberately not built now to avoid infrastructure for two booleans.

## 10. Analytics

`src/server/services/creator-analytics.ts` — read-side aggregation over `CreatorGeneration`/`CreatorPost`
(same pattern as the existing CRM dashboard analytics: no write-side event log). Generation counts by
type/status, credits consumed, average latency; posts by platform/status, autopilot-vs-manual published
counts, average approval turnaround. Content performance (views/likes/reach) is out of scope for v1 —
every real social adapter is blocked, so there is no live metrics source to aggregate.

## 11. Security & tenant isolation

- Every service resolves its Prisma client via `tenantDb(ctx.orgId)` — the caller's own session-derived
  org, never a client-supplied value — for reads and writes alike; `tenantDb`'s extension additionally
  overrides `organizationId` in every write payload so it can't be reassigned across tenants.
- `publishCreatorPost` re-scopes by `organizationId` on every job invocation (the job payload only
  carries IDs; ownership is re-verified, not assumed).
- RBAC: `creator:read`, `creator:write`, `creator:generate`, `creator:approve`, `creator:publish`,
  `creator:manage-social-accounts`, `creator:manage-autopilot` (`src/server/auth/permissions.ts`).
  VIEWER: read-only. MEMBER: read/write/generate (drafts + generation, no approve/publish/social/
  autopilot). MANAGER/ADMIN/OWNER: full.
- Uploads: reference images go through the same signed-URL-intent pattern as documents
  (`DocumentUploadIntent`, reused), with image-specific magic-byte verification
  (`src/server/security/creator-asset-ingestion.ts` — JPEG/PNG/WEBP signature checks; document-ingestion's
  own `verifyUploadObject` is a closed switch over document MIME types, so this is a small parallel
  module reusing the generic `validateUploadIntent`/`assertTenantStoragePath` pieces of it).
- Consent: `CreatorProfile.consentConfirmedAt` is required (with ≥3 approved reference images) before any
  generation touching that profile is allowed (`requireActiveProfileWithReferences` in
  `creator-generations.ts`).
- Every mutating action is audit-logged (`src/server/services/audit.ts`) with a `creator.*` action name.
- Rate limiting: a dedicated `creatorGenerate` limiter (20/min, `src/server/integrations/redis.ts`) on the
  four cost-amplifying generation endpoints; the shared `api` limiter elsewhere.

## 12. Adding a real provider

**A further/premium image or video vendor** (e.g. Veo): implement `CreatorMediaProvider`
(`src/server/ai/creator/types.ts`) as a new class, add it to `PROVIDERS` and
`CreatorMediaProviderName` in `src/server/ai/creator/router.ts`, and extend `resolveMediaProviderName()`'s
auto-detection (or rely on the existing `CREATOR_MEDIA_PROVIDER` env pin) — behind its own
`getXxxEnv()`-style env validation (§4 of the charter: don't couple to unrelated integrations' config).
No calling code changes; `fal-provider.ts` is the reference implementation.

**TikTok or YouTube** (the two platforms deliberately left blocked in this pass): replace the relevant
`Blocked*PublishingProvider` in `src/server/social/blocked-adapter.ts` with a real adapter (OAuth app must
be registered/approved first — see each adapter's `blockedReason` for exactly what that vendor requires),
register it in `REAL_ADAPTERS` in `src/server/social/index.ts`, and make `isConfigured()` reflect real
credential presence so `getSocialPublishingProvider()` picks it automatically. `meta-provider.ts` (for
Instagram/Facebook) is the reference implementation for wiring a real OAuth flow through the existing
callback-route + signed-state pattern.

**Template**: add an entry to `globalCreatorTemplates` in `prisma/seed.ts` (or create an org-scoped one
via a future admin UI — not built in v1) and re-run `npm run db:seed`.

## 13. Testing

`tests/unit/creator-*.test.ts` — Prisma is mocked throughout (no live Postgres in most dev/CI
environments for this branch); these are unit + service-level integration tests, not full DB+RLS
integration tests (the existing CI pipeline's separate RLS-isolation jobs are the place for that, once
this migration is applied to a real Supabase-backed environment):

- `creator-credits.test.ts` — pricing function, atomic reserve/commit/release, concurrent-overspend
  prevention, tenant scoping.
- `creator-posts-workflow.test.ts` — approval state machine, content-version-invalidates-approval,
  scheduling guards, `evaluateAutopilotRules` (every rejection reason).
- `creator-publishing.test.ts` — the full publish guard chain, idempotent claim, tenant isolation,
  sanitized error handling.
- `creator-studio-integration.test.ts` — `creator-posts` + `creator-publishing` chained against one
  evolving mock post: DRAFT→APPROVED→SCHEDULED→PUBLISHED, retry-after-failure, rejected-can-never-
  publish, edited-after-approval-blocks-publish.
- `creator-rbac.test.ts`, `creator-tenant-isolation.test.ts`, `creator-social-provider.test.ts`,
  `creator-caption-provider.test.ts` (mocks `streamClaude` — no live Anthropic call).
- `fal-integration.test.ts`, `fal-provider.test.ts`, `creator-media-router.test.ts` — the fal.ai queue
  client, `FalCreatorMediaProvider`, and provider routing/auto-detection, all against a mocked `fetch` and
  mocked Supabase Storage (no live fal.ai account or credentials used).
- `meta-integration.test.ts`, `meta-provider.test.ts`, `social-oauth-state.test.ts` — the Meta Graph API
  client (authorize URL, token exchange, Page listing, Facebook/Instagram publish, container polling),
  `InstagramPublishingProvider`/`FacebookPublishingProvider`, and the OAuth callback's signed-state
  build/verify/tamper/expiry handling, all against a mocked `fetch` (no live Meta app or credentials
  used).

**Live RLS tenant-isolation verification**: this migration's RLS policies (`creator_profiles`,
`creator_campaigns`, `creator_generations`, `creator_posts`, `creator_templates`) were verified against a
real local Postgres instance running the repo's own CI-grade harness (`scripts/ci/run-rls-check.sh`,
`tests/rls/creator-studio-*.sql`) — both as a superuser and as a non-superuser role restricted to exactly
the `authenticated`/`anon` grant set, matching the two `rls`/`rls-non-superuser` CI jobs. This is what
caught and fixed a real gap: `creator_profiles_update`/`creator_campaigns_update` originally had `USING`
but no `WITH CHECK`, which would have allowed an authenticated user to reassign a row's
`organization_id` to a different tenant via `UPDATE` — the exact vulnerability class
`docs/RLS-UPDATE-WITH-CHECK-HARDENING.md` already documents as fixed for 16 other tables. Both policies
now carry `WITH CHECK (organization_id = auth_org_id())`.

**Opt-in live E2E**: `tests/e2e/creator-studio-live.spec.ts` exercises the full golden path (creator →
reference assets → consent → image → video if available → caption → campaign → post → approval →
schedule → publish → analytics → credit ledger) through the real HTTP API against a live deployed
environment, with real fal.ai/Meta calls when those are configured there. Gated behind
`CREATOR_STUDIO_LIVE_E2E=1` and never runs under `npm test` or any automated CI path — see the file's own
header comment for exactly what it needs, what it publishes, and how each provider-dependent stage
degrades explicitly (never silently) when this environment isn't configured for it. The same golden path
with every provider mocked remains fully exercised at the service layer by the tests above, which do run
in every CI build.

## 14. Rollout plan

1. A human runs `npm run db:deploy` (or the equivalent CI migration step) against a real Supabase project,
   then re-runs `prisma/sql/003_rls.sql` and `prisma/sql/004_storage.sql` (idempotent, safe to re-run) to
   pick up the new storage buckets/policies.
2. `npm run db:seed` to load the 10 global templates.
3. Set `SOCIAL_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) in the deployment environment before
   enabling any org.
4. Flip `creator_studio_v1` on for a pilot organization via `setFeatureEnabled` (no admin UI yet — a
   direct call or a small internal script).
5. Verify the mocked end-to-end flow manually in that org before enabling any real provider.
6. Autopilot stays off (`creator_studio_autopilot` unset) until real publishing is verified working for
   that org — autopilot with only mock publishing has no real-world effect but should still not be
   exposed to customers as if it does something.
7. **To enable real image/video generation**: set `FAL_API_KEY` (and optionally
   `FAL_IMAGE_MODEL`/`FAL_IMAGE_TO_VIDEO_MODEL` to override the defaults) — `FalCreatorMediaProvider`
   activates automatically for every org with the feature flag on (§7); no per-org opt-in exists yet.
8. **To enable real Instagram/Facebook publishing**: register one Meta app (Facebook Login for Business,
   Instagram Graph API + Pages API products, App Review for `pages_manage_posts` /
   `instagram_content_publish` and the other scopes in `meta-provider.ts`), set `META_APP_ID` /
   `META_APP_SECRET` (and optionally `META_GRAPH_API_VERSION`, `META_OAUTH_STATE_SECRET`), and register
   the app's OAuth redirect URI as
   `{NEXT_PUBLIC_APP_URL}/api/v1/creator-studio/social-accounts/oauth/meta/callback`. Each org then
   connects its own Facebook Page/Instagram account from Creator Studio → Social accounts, which redirects
   to Meta's real OAuth dialog (§8).
9. TikTok and YouTube publishing remain out of scope for this release (§1, §8, §12) — do not represent
   Creator Studio as capable of publishing to either until a dedicated follow-up mission implements their
   adapters and their respective app reviews are approved.
10. Before wider rollout beyond the pilot org, run `tests/e2e/creator-studio-live.spec.ts`
    (`CREATOR_STUDIO_LIVE_E2E=1`, §13) against the target environment once real credentials are configured,
    to prove the real fal.ai/Meta round trip end-to-end — on a dedicated test Page/account, never the
    pilot org's real production social account, since it publishes a real post.

## 15. Generation lifecycle safety — known gaps (production-readiness audit)

A real live Kling video generation (`fal-ai/kling-video/v2.1/standard/image-to-video`, 5s) took ~71
seconds end-to-end. `runGeneration` (`creator-generations.ts`) now guards its COMPLETED/FAILED
transitions with a conditional `updateMany` (`where: { status: "GENERATING" }`, count-checked) before
committing or releasing credits — the same claim pattern `publishCreatorPost` already uses — so a
generation can never be double-committed or double-released even if some future code path re-processes
the same row. `video-from-image`'s route now sets `maxDuration = 300`, matching `runFalModel`'s own poll
ceiling (`MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS`), so the platform's default function timeout doesn't kill
a real generation while fal.ai keeps processing.

What remains **not** solved, and requires deliberate follow-up work rather than a quiet patch:

- **No reconciliation for abandoned `GENERATING` rows.** If the Node process running a generation is
  killed (OOM, deploy, host failure) between `reserveCreatorCredits` and the completion/failure
  transition, the row stays `GENERATING` forever and its reserved credits are never released back to the
  org's available balance — there is currently no scheduled job that scans for and resolves stale
  `GENERATING` rows. Building one safely requires deciding a staleness threshold and, more importantly,
  how to avoid crediting back a reservation whose provider call actually _succeeded_ after Syveka lost
  track of it (see below) — a real design decision, not a one-line fix. **HUMAN REVIEW / FOLLOW-UP
  ARCHITECTURE.**
- **fal.ai's queue `request_id`/`status_url` is never persisted until the whole generation finishes.**
  `runFalModel` (`src/server/integrations/fal.ts`) holds these only in a local variable through its
  poll loop; if the process dies mid-poll, there is no way to look the job back up on fal.ai's side —
  the provider may still complete and even bill for a generation Syveka can no longer identify. Preserving
  this earlier is possible in principle (`CreatorGeneration.providerRequestId` is already a nullable
  column), but doing so correctly requires threading a submission callback through the
  `CreatorMediaProvider` interface, `runFalModel`, and `runGeneration` — a real interface change, not
  wired up on spec elsewhere yet, and not implemented in this pass since nothing currently reads it back.
  Implementing this without also building the reconciliation job above would add write cost without a
  consumer. **HUMAN REVIEW / FOLLOW-UP ARCHITECTURE.**
- **A client-level duplicate request (e.g. a retried POST after a network glitch) creates a second,
  independent `CreatorGeneration` row** with its own fresh credit reservation — `runGeneration` always
  `create`s a new row, so the idempotency guard above (keyed on one row's `id`) does not prevent a
  double-charge from two separate HTTP requests for "the same" logical generation. No client-supplied
  idempotency key exists on these routes today. Out of scope for this pass; flagged for awareness.
- **FIXED**: a `commitCreatorCredits`/`audit` failure _after_ a successful COMPLETED claim used to still
  be reported to the caller as a generation failure. `finalizeCompletedGenerationBookkeeping` now runs
  the commit and audit steps in their own isolated try/catch, outside the `execute()`-guarding
  `try`/`catch` — a failure in either is logged (`console.error`, no secrets) but never rethrown, never
  attempts a FAILED transition on an already-COMPLETED row, and never releases credits for a generation
  that has already succeeded. `commitCreatorCredits` is deliberately not retried on failure: it is not
  provably idempotent (its balance `updateMany` and its `CreatorCreditTransaction` insert are two
  separate statements, not one transaction), so credits can still remain stuck `RESERVED` in that one
  sub-case — that residual stuck-credit risk is the same class as the abandoned-`GENERATING` gap above
  and is resolved by the same future reconciliation work, not by this fix. Proven by 6 focused tests in
  `tests/unit/creator-generations.test.ts`, including COMMIT-throws-after-COMPLETED and
  audit-throws-after-COMMIT cases.
