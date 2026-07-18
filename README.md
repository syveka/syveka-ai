# Syveka AI

Multi-tenant AI business assistant for Finnish SMBs.
Architecture source of truth: `syveka-ai-architecture.md` (repo root / docs).

## Stack

Next.js 15 (App Router) · TypeScript strict · Tailwind + shadcn/ui · Supabase (Postgres + pgvector, Auth, Storage, Realtime) · Prisma · Anthropic Claude + OpenAI · Vapi · Stripe · Resend · Upstash (Redis + QStash) · next-intl (fi/en/ar, RTL).

## Setup

```bash
npm install
cp .env.example .env        # fill in all values (env.ts fails the build otherwise)

# Database
npm run db:migrate          # Prisma migrations
psql $DIRECT_URL -f prisma/sql/001_extensions_and_indexes.sql
psql $DIRECT_URL -f prisma/sql/002_functions.sql
psql $DIRECT_URL -f prisma/sql/003_rls.sql
psql $DIRECT_URL -f prisma/sql/004_storage.sql
npm run db:seed             # global prompt library + default pipeline data

# Calendar & Booking RLS is applied by the tracked Prisma migration
# 20260718000000_calendar_booking_rls. Do not run prisma/sql/005 separately.

# Supabase dashboard (one-time):
#  - Auth → Hooks → register public.custom_access_token_hook (access token hook)
#  - Auth → Providers → enable Google OAuth
#  - Auth → Email templates → localized templates

# Stripe (test mode):
#  - create Products syveka_starter / syveka_pro with monthly+annual EUR prices
#  - paste price ids into .env
stripe listen --forward-to localhost:3000/api/v1/webhooks/stripe

npm run dev
```

## Add remaining shadcn primitives

Owned primitives live in `src/components/ui`. Add more with:

```bash
npx shadcn@latest add dialog dropdown-menu avatar tooltip table tabs badge select sheet sonner
```

## Non-negotiable conventions

- **Tenant isolation (§4.3):** never import `@/server/db/prisma` outside `src/server/db` (ESLint-enforced). Business code uses `tenantDb(ctx.orgId)`.
- **Permissions (§12.3):** every Server Action / API handler starts with `requirePermission("...")`.
- **RTL (§20):** logical Tailwind utilities only (`ms-* me-* ps-* pe-* text-start`).
- **Validation (§21):** Zod schemas in `src/lib/validators` are shared by forms and actions.
- **Money:** integer cents. **IDs:** uuid. **Audit:** every sensitive mutation calls `audit()`.

## Implementation status (v0.1)

| Module                                                                                                   | Status |
| -------------------------------------------------------------------------------------------------------- | ------ |
| Foundation: Next 15 · TS strict · Tailwind/shadcn · Prisma (30 tables) · RLS · Supabase · env validation | ✅     |
| Auth: login/register/magic link/forgot/reset/verify · onboarding · invites · org switch                  | ✅     |
| RBAC: 5-role matrix · `requirePermission` · audit-logged denials                                         | ✅     |
| AI Chat: SSE streaming · model router · guardrails · tools · citations · quotas                          | ✅     |
| Knowledge Base: upload → extract → chunk → embed (pgvector) → RAG                                        | ✅     |
| CRM: contacts (search/filter/GDPR) · deals kanban · activities · audit                                   | ✅     |
| Calendar: month view · event CRUD · Voice-AI-badged events                                               | ✅     |
| Voice AI: Vapi sync · +358 provisioning · in-call tools · post-call pipeline                             | ✅     |
| Workflows: 6 triggers · 6 step types · resumable QStash runner · builder UI                              | ✅     |
| Billing: Stripe checkout/portal/webhooks · entitlements · usage meters · plan cards                      | ✅     |
| Notifications: in-app feed · Realtime badge · email templates                                            | ✅     |
| Analytics: sales funnel · AI usage · voice sentiment (SSR SVG charts)                                    | ✅     |
| Prompt Library: global+org templates · variables · use-in-chat                                           | ✅     |
| Settings: profile · organization+AI instructions · members · billing · API keys · audit log              | ✅     |
| Superadmin: org overview · platform usage                                                                | ✅     |
| CI/CD: lint/type/test · i18n parity · gitleaks · RLS isolation job · staged deploy                       | ✅     |
| Tests: unit (RBAC, chunker, citations, plans, interpolation) · RLS SQL · Playwright smoke                | ✅     |
| GDPR: consent capture · retention purge job · erasure Edge Function · EU-only infra                      | ✅     |

**Deferred to Phase 3 (per roadmap §25):** public REST API surface beyond webhooks (auth helper `resolveApiKey` is ready), Google/Outlook calendar sync, CSV contact import UI, PWA push, reranking, custom-LLM voice mode.

### Verify locally

```bash
npm install          # (registry unavailable in the build sandbox — run locally)
npm run typecheck && npm test
node scripts/check-i18n-parity.mjs
```
