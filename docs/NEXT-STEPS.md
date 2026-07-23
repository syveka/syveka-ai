# Syveka AI — Next Steps

Snapshot date: **2026-07-23**. Exact implementation sequence, split by who/what performs each
task. The first task listed under "Codex implementation" is the highest-value safe next step
based on the full audit.

## Tasks for ChatGPT planning

1. Review this documentation set (`docs/PROJECT-CONTEXT.md` through `docs/CHANGELOG.md`) and
   confirm the P0/P1 sequencing in `ROADMAP.md` matches business priorities.
2. Decide the open items in `DECISIONS.md` ("Open decisions requiring owner input"): fate of
   `zustand`/`react-query`, whether to finish the OpenAI failover path, `next-intl` major-version
   timing, Sentry/Langfuse integration plan.
3. Write the PRD for Organization self-serve deletion (P2) before Codex implements it — this
   touches a GDPR-adjacent irreversible action and deserves explicit UX/legal-copy review first.
4. Plan the CSP rollout (P0.3) — needs an inventory of every third-party script/style origin
   currently in use (Stripe Checkout, Vapi widget, Supabase, Google avatar images) before Codex
   writes the policy, to avoid breaking functionality on first deploy.

## Tasks for Codex implementation

**First task (highest-value safe next step)**: **P0.1 — fix the failing dependency audit.**
Run `npm audit fix` for `next`/`postcss`/`sharp`, run the full local check suite
(`npm run lint && npm run typecheck && npm test && npm run build && npx prisma validate`),
confirm `npm audit --omit=dev --audit-level=high` now passes, and open a PR. Evaluate the
`next-intl` 4.x bump as a separate, clearly-labeled follow-up PR (breaking change). See
`CODEX-HANDOFF.md` for full acceptance criteria.

Then, in order: 2. P0.2 — Calendar webhook signature verification. 3. P0.4 — Rate limiting on the four file/URL-ingestion endpoints. 4. P0.3 — CSP implementation (after ChatGPT's script/style-origin inventory). 5. P1 items: `getFreshTokens()` hardening, RAG general-search filter fix, Vapi webhook replay
protection, automated route-auth-coverage test. 6. P1 i18n coverage completion (mechanical, low-risk, can be parallelized with the above). 7. P2 items per `ROADMAP.md`, once P0/P1 are clear.

## Tasks requiring Claude

- Re-run this audit (or a targeted subset) after the P0/P1 sprint completes, to verify fixes
  and refresh `PROJECT-STATUS.md`/`SECURITY-AUDIT.md`/`CI-PRODUCTION-READINESS.md` before the
  first staging dispatch.
- Any future large-context, cross-cutting synthesis task (new module audits, pre-launch
  documentation review) — per the standing decision that Claude is used only where it provides
  exceptional value.

## Tasks requiring Supabase (owner action)

- Confirm `prisma/sql/004_storage.sql` (Storage buckets + policies) has actually been applied to
  every environment that matters (staging, and eventually production) — it has no tracked
  Prisma migration and is easy to miss on a fresh environment.
- Verify the `custom_access_token_hook` is registered in Auth → Hooks for any new Supabase
  project (staging, production) per `README.md` setup instructions.
- Confirm Google OAuth provider is enabled if/when external calendar sync goes live for real
  users (currently works via the MOCK provider in dev/test).

## Tasks requiring GitHub (owner action)

- Set up the `staging` and `production` GitHub Environments exactly as specified in
  `docs/ci-deployment-enforcement.md` (branch protection, required reviewers, secrets) if not
  already done — this audit did not verify Environment configuration itself (out of scope for
  a read-only repo audit).
- Confirm branch protection on `main` requires the `CI required` check per
  `docs/ci-deployment-enforcement.md`.

## Tasks requiring manual owner approval

- Any change to the `DATABASE_URL`/`DIRECT_URL` connection role (see `DECISIONS.md` — explicitly
  flagged as requiring architecture review, not a routine fix).
- The `next-intl` major-version upgrade (breaking change).
- Organization self-serve deletion — irreversible, GDPR-adjacent, needs explicit sign-off on the
  UX/copy before implementation, not just the technical PRD.
- The first production `workflow_dispatch` deploy, per the existing (and correct) approval gate
  in `docs/release-runbook.md` — requires backup/PITR verification and reviewer approval, not a
  Codex or Claude action.

## Tasks requiring production credentials

- Nothing in the P0/P1 sequence above requires production credentials — all of it is code-level
  fixes validated by local/CI checks and a staging dispatch.
- Production credentials are only needed for the final `deploy.yml` dispatch itself, which is
  explicitly out of scope until P0/P1 are complete and a successful staging run exists for the
  candidate SHA.
