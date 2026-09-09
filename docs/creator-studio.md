# Creator Studio v1

AI character → image → video → caption → approval → schedule → publish → analytics, built on top of
Syveka's existing tenant/RBAC/billing/job/storage infrastructure rather than a parallel stack. This
document is the technical reference for the feature; it does not set policy — see `CLAUDE.md` for that.

## 1. Status (read this first)

Creator Studio v1 is a **real, working foundation with mocked media generation and mocked social
publishing**. Concretely:

- **Real**: tenant-scoped schema + RLS, RBAC, the credit reserve/commit/release ledger, the approval
  state machine, autopilot rule evaluation, the scheduling/publishing engine (idempotent claim,
  retry-safe), caption generation (calls the real Anthropic integration), audit logging, notifications,
  FI/EN/AR i18n (RTL-correct), and the full UI flow.
- **Mocked**: image and video generation (`MockCreatorMediaProvider` — no image/video vendor is wired in;
  see §7). Social publishing (`MockSocialPublishingProvider`, used automatically outside production, or
  when `CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1`) — the four real adapters (Instagram, Facebook, TikTok,
  YouTube) exist and implement the `SocialPublishingProvider` interface, but every method throws
  `SocialProviderNotImplementedError`; none has OAuth app credentials configured (see §8).

Both mocked layers are deliberately **interface-complete**: swapping in a real provider means writing one
new adapter class, not touching any calling code.

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

- **Media**: `MockCreatorMediaProvider` (`mock-provider.ts`) — deterministic, no network call, returns a
  synthetic storage path. It is the only registered media provider; no real image/video vendor SDK is
  wired into this codebase (adding one is a scoped follow-up, not attempted here — see §12).
- **Caption**: `ClaudeCaptionProvider` (`caption-provider.ts`) — a real call through the platform's
  existing `streamClaude()` (`src/server/integrations/anthropic.ts`), `routeModel("draft")`. Prompts the
  model for strict JSON (`{primary, short, cta, hashtags}`), reuses `getBusinessDnaContext` +
  `buildBusinessDnaPromptBlock` for brand-voice grounding (with the existing prompt-injection wrapping).
  Tests mock `streamClaude` — this must never make a live call in CI.

## 8. Social publishing providers

`src/server/social/` — `SocialPublishingProvider` (`connectAccount`, `refreshConnection`, `publishPost`,
`getPublishStatus`, `revokeConnection`), one instance per `SocialPlatform` via
`getSocialPublishingProvider(platform)`.

- `MockSocialPublishingProvider` (`mock.ts`) — used whenever a real adapter reports `isConfigured() ===
false` and either `NODE_ENV !== "production"` or `CREATOR_STUDIO_SOCIAL_MOCK_PROVIDER=1` is set;
  otherwise the function throws rather than silently no-op-publishing in production.
- Real adapters (`blocked-adapter.ts`): `InstagramPublishingProvider`, `FacebookPublishingProvider`,
  `TikTokPublishingProvider`, `YouTubePublishingProvider` all implement the full interface and all
  currently throw `SocialProviderNotImplementedError` for every method, with a `blockedReason` string
  naming exactly what's missing (app registration, API review, OAuth credentials) — see §12 for what
  each needs.
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

**Image/video vendor**: implement `CreatorMediaProvider` (`src/server/ai/creator/types.ts`) as a new
class, register it in `getCreatorMediaProvider()` (`src/server/ai/creator/index.ts`) — behind its own
`getXxxEnv()`-style env validation (§4 of the charter: don't couple to unrelated integrations' config).
No calling code changes.

**Social platform**: replace the relevant `Blocked*PublishingProvider` in
`src/server/social/blocked-adapter.ts` with a real adapter (OAuth app must be registered/approved first —
see each adapter's `blockedReason` for exactly what that vendor requires), and make `isConfigured()`
reflect real credential presence so `getSocialPublishingProvider()` picks it automatically.

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

**Not written in this pass**: Playwright E2E. The existing `tests/e2e` suite requires a live
`E2E_BASE_URL` running app plus a real Supabase-backed test user provisioned via `auth.setup.ts` — neither
was available in the environment this feature was built in. Writing an E2E spec without being able to run
it against the real app/DOM would be unverified and is more likely to mislead than help; the golden path
it should cover (login → open Creator Studio → create creator → generate mock image → generate caption →
create campaign → add post → request approval → approve → schedule → mock publish → verify Published +
audit + analytics + credit ledger) is fully exercised at the service layer by the tests above instead.

## 14. Rollout plan

1. A human runs `npm run db:deploy` (or the equivalent CI migration step) against a real Supabase project,
   then re-runs `prisma/sql/003_rls.sql` and `prisma/sql/004_storage.sql` (idempotent, safe to re-run) to
   pick up the new storage buckets/policies.
2. `npm run db:seed` to load the 10 global templates.
3. Set `SOCIAL_TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) in the deployment environment before
   enabling any org.
4. Flip `creator_studio_v1` on for a pilot organization via `setFeatureEnabled` (no admin UI yet — a
   direct call or a small internal script).
5. Verify the mock end-to-end flow manually in that org before wider rollout.
6. Autopilot stays off (`creator_studio_autopilot` unset) until a real social adapter exists — autopilot
   with only mock publishing has no real-world effect but should still not be exposed to customers as if
   it does something.
7. Real image/video + real social publishing are separate, scoped follow-up missions (§12) — do not
   represent this release as capable of real customer-facing publishing until at least one real social
   adapter is implemented and its OAuth app is approved by the platform.
