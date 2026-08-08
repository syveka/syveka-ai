---
name: verify
description: Run this repo's required validation checklist (CLAUDE.md §3) against the current change set and report each command as PASS/FAIL/NOT APPLICABLE. Use before committing, before opening a PR, or whenever asked to validate/verify changes.
---

Run the CLAUDE.md §3 validation suite for this repo, scoped to what actually changed. Do not
skip, weaken, or reinterpret a failing check — report it with its root cause per CLAUDE.md §3.

## 1. Determine the change set

```
git status --porcelain
git diff --name-only origin/main...HEAD
```

Combine both (uncommitted + committed-on-branch) into one list of changed paths. This drives the
conditional checks below.

## 2. Always run

```
npm run format:check
npm run lint
npm run typecheck
npm test
```

## 3. Conditionally run

- `npm run i18n:check` — if any changed path is under `messages/` or `src/i18n/`, or touches
  user-facing strings elsewhere in `src/`.
- `npm run migrations:check` — if any changed path is under `prisma/migrations/` or is
  `prisma/schema.prisma`.
- `npm run build` — if changed paths include `package.json`, `tsconfig.json`, `next.config.*`,
  `middleware.ts`, or a broad set of `src/` files (i.e. the change could plausibly affect
  production compilation). Use `SKIP_ENV_VALIDATION=1` plus the placeholder env vars already
  allowlisted in `.claude/settings.local.json` if real secrets aren't available locally.
- `npm run test:e2e` — only for changes touching authentication, `src/app/api/**`, routing,
  `middleware.ts`, or other critical user-flow code. Note this is a real Playwright run, not
  part of the PR-gating CI (`ci.yml` only runs it via `staging-release.yml` post-deploy) — treat
  it as an agent-side check, not a CI status.

Skip (report NOT APPLICABLE) any conditional check whose trigger paths aren't in the change set.

## 4. Report

For every command in §2 and §3, report one line: **PASS**, **FAIL** (with the root cause), or
**NOT APPLICABLE** (with why it didn't apply). Never claim a check passed unless it actually ran
and completed successfully.
