# Syveka AI — Codex Handoff

Technical implementation handoff for the next task. This is the **only** task assigned right
now — do not start on P1/P2 items from `ROADMAP.md` without a fresh handoff, even if they look
quick.

## Current target

**P0.1 — Fix the failing `production-dependency-audit` CI gate.**

## Why this is first

`npm audit --omit=dev --audit-level=high` — the exact command the blocking
`production-dependency-audit` job in `.github/workflows/ci.yml` runs — currently fails locally
(verified 2026-07-23) with vulnerabilities that were **not** present when this job last passed
in CI on 2026-07-20 (run `29712079180`, PR #9). This means PR #9's current green CI status is
stale: the next push or manual re-run of this workflow will fail this gate until dependencies
are bumped. Every other P0/P1 item is lower urgency than unblocking CI itself.

## Scope

In scope:

- Bump `next`, and whatever nested `postcss`/`sharp` versions come along with it, via
  `npm audit fix` (non-breaking within `next`'s declared `^15.2.0` range).
- Evaluate (separately, see below) the `next-intl` moderate CVE, which requires
  `npm audit fix --force` (breaking: 3.x → 4.x).

Out of scope (do not touch in this task):

- Any other item in `ROADMAP.md` P0–P4.
- Any application code changes beyond what's needed to keep the build/tests green after the
  dependency bump.
- Any database migration, schema change, or RLS policy change.
- Any production/staging deployment or workflow dispatch.

## Acceptance criteria

1. `npm audit --omit=dev --audit-level=high` exits 0 (or the `next-intl` finding is explicitly
   deferred to a separate, clearly-labeled follow-up PR — see below — in which case document
   that in the PR description).
2. `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all still pass after the
   bump.
3. `npx prisma validate` and `npx prisma generate` still pass (should be unaffected, but verify —
   Prisma itself is not part of this bump).
4. No application code changes beyond what's strictly required to compile/pass tests against
   the new dependency versions (e.g. a type signature that changed upstream). If `next`'s bump
   requires any code change, document exactly what and why in the PR description.
5. `package-lock.json` is updated and committed alongside `package.json`.

## Relevant files

- `package.json`, `package-lock.json` (the actual change).
- `.github/workflows/ci.yml` — the `production-dependency-audit` job, for reference on the exact
  command/flags being gated (do not modify this file unless the audit command itself needs to
  change, which is not expected).
- `next.config.ts` — check after the bump in case any Next.js config API changed (unlikely for
  a patch/minor bump within `^15.2.0`, but verify the build output is clean).

## Database impact

None. This is a dependency-only change.

## Security requirements

- Confirm the specific CVEs being patched (DoS in Server Actions, SSRF in Server Actions on
  custom servers, response-body cache confusion, unbounded Server Action payload on Edge
  runtime, SSRF via rewrites, DoS in Image Optimization SVG handling, unauthenticated disclosure
  of internal Server Function endpoints for `next`; XSS/arbitrary-file-read for `postcss`;
  libvips CVEs for `sharp`) are actually resolved by checking the installed version against each
  advisory's patched-version range after `npm audit fix` — don't just trust exit code 0 without
  spot-checking the advisory details `npm audit` prints.
- Do not use `npm audit fix --force` for anything in the non-breaking group — only `next-intl`
  needs `--force`, and it should be a separate PR (see below), not bundled into this one.

## The `next-intl` decision (handle as a separate follow-up, do not block this task on it)

`next-intl` 3.26.5 → patched at 4.9.1+ is a **major version bump** (breaking changes). This
repo's i18n usage (`src/i18n/{routing,request}.ts`, `useTranslations`/`getTranslations` calls
throughout) needs to be checked against next-intl's 4.x migration guide before taking this
upgrade. **Open a second, clearly-labeled PR for this** rather than bundling it with the P0.1
fix — the moderate-severity finding does not block the `--audit-level=high` gate, so it does not
have to be resolved in the same PR as the high-severity fixes. Flag it to ChatGPT/owner for
timing per `NEXT-STEPS.md`.

## Testing requirements

Run the full local validation suite before opening the PR:

```
npm ci
npx prisma validate
npx prisma generate
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

All must pass (the last one is the actual point of this task). CI will additionally run the
`rls` and `migration-upgrade` jobs (live Postgres, not runnable locally without a DB) and
`secret-scan` (Docker) — these are not expected to be affected by a dependency bump, but let CI
confirm.

## Commands to validate

Same block as above. Additionally, after `npm audit fix`, run `npm audit --omit=dev
--audit-level=high` a second time to confirm zero remaining high-severity findings before
committing.

## Prohibited changes

- Do not modify `prisma/schema.prisma`, any file under `prisma/migrations/`, or any file under
  `prisma/sql/`.
- Do not modify RLS policies, `src/server/db/tenant.ts`, or `src/server/security/*`.
- Do not modify `.github/workflows/*.yml` beyond what's strictly necessary (not expected to be
  necessary at all for this task).
- Do not touch `.env.local`, `.env.example`, or any secret.
- Do not force-push, merge this PR, or dispatch any release workflow — open the PR and stop.
- Do not bundle the `next-intl` major bump into this PR.

## Definition of done

- PR opened against `main` (or against the current `chore/staging-release-validation` branch if
  that's still the active integration branch at the time — confirm with `git branch
--show-current` and `gh pr list` before choosing the base) with the dependency bump, updated
  lockfile, and a description listing exactly which CVEs are resolved.
- All commands in "Testing requirements" pass locally.
- CI's `production-dependency-audit` job passes on the PR.
- `next-intl` upgrade is explicitly deferred and tracked as a separate follow-up, not silently
  dropped.
