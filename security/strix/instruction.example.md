# Strix instruction file template

Copy to `instruction.local.md` (gitignored), fill in, and pass with `--instruction-file`.
Never put real customer data, production credentials or production hostnames here. Everything in
this file is sent to the model provider.

## Authorization

- Authorized by: <name, date>
- Commit under test: <sha>
- Target(s): <clean checkout path and/or the base URL from targets.local.txt>
- Budget cap: <USD, must match --max-budget>
- Findings go to: <private channel>

## System context

Syveka AI is a multi-tenant Next.js / Prisma / Supabase SaaS. The tenant boundary is enforced in
the application: `tenantDb(orgId)` (src/server/db/tenant.ts) injects `organizationId` into
queries, and `unscopedPrisma` is the manual escape hatch used by webhooks and jobs. The
organization id must come from the server-verified session, never from the request. RBAC is in
src/server/auth/permissions.ts (`OWNER`, `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`) and API-key
scopes map onto the same permissions. The Prisma database role bypasses Postgres RLS; RLS only
protects Supabase-native client paths. AI tools live in src/server/ai/tools/ and some require an
explicit user confirmation before execution.

Attacker-controlled inputs: every route under src/app/api/v1/\*\*, Server Actions, uploaded
documents and URLs, inbound e-mail, voice-call transcripts, chat messages, booking and
public-assistant pages, and webhook bodies.

## Priorities (in order)

1. Cross-tenant data access and authorization.
2. Authentication, roles and admin boundaries.
3. Supabase RLS and server-side database access.
4. API authorization including IDOR/BOLA.
5. AI tool execution and required-confirmation enforcement.
6. Prompt injection that could bypass tool permissions or expose tenant data.
7. Webhook authentication, signatures and replay handling.
8. Secret exposure, SSRF, injection and unsafe uploads.

## Test accounts (phase 2 only; throwaway values, rotate after the run)

- Organization A owner: <email> / <password>
- Organization A member: <email> / <password>
- Organization B owner: <email> / <password>
- User in no organization: <email> / <password>
- API key, organization A (minimal scopes): <key>
- Known object ids for cross-tenant checks: <contact/document/conversation ids per org>

## Out of scope / do not do

- Do not send e-mail, place or answer voice calls, create charges or subscriptions, or trigger
  workflows that notify anyone. The target must be configured with mocks or test modes, but do not
  rely on that.
- Do not contact any host that is not listed in the target list.
- Do not perform denial-of-service, mass data creation, or destructive admin actions beyond what
  is needed to prove one finding once.
- Report every finding with the exact request, the file and line, and the data that proves impact.
