# Staging release hardening (2026-11-11)

**Summary.** `staging-release.yml` gates every step, but it has five gaps an approver can't see
from the run page. This change adds the script and tests that close the first two. The workflow
edit that uses the script is written out below as a patch for the owner to apply, because
`.github/workflows/*` is protected configuration. Nothing here was dispatched or deployed.

Audited at `main` = `aaf36c47`. Line numbers refer to `.github/workflows/staging-release.yml` at
that commit.

## What the workflow enforces today

One job, 43 steps, no `continue-on-error`. A failed step stops the run.

| Order | Gate                                                                                 | Lines   |
| ----- | ------------------------------------------------------------------------------------ | ------- |
| 1     | Environment `staging` approval (one required reviewer, `main` only)                  | 27      |
| 2     | Target checks: ref is `main`, staging project differs from production                | 30–61   |
| 3     | `migrations:check`, `format:check`, `i18n:check`, `lint`, `typecheck`, `npm test`    | 86–105  |
| 4     | `prisma validate`, production dependency audit, `npm run build`, Prisma engine check | 107–128 |
| 5     | `prisma migrate deploy` on the staging database, then `migrate status`               | 135–142 |
| 6     | RLS and tenant invariants, storage policy checks, provider configuration checks      | 147–195 |
| 7     | Preview build and deploy, health check on the released SHA, e2e smoke suite          | 206–483 |
| 8     | Production-scoped build and deploy to the stable alias                               | 497–600 |
| 9     | Stable alias health, auth journeys, e2e smoke suite on the stable alias              | 605–670 |

## Gaps

| #   | Gap                                                                                                                                                                                                              | Consequence                                                                                                         | Closed by                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1   | **CI on the released commit is assumed.** The workflow makes no GitHub API call. It re-runs part of CI but not the secret scan, the migration upgrade and baseline jobs, or the non-superuser RLS job.           | A dispatch while main CI is red or still running releases that commit.                                              | Script in this change, plus patch A    |
| 2   | **Approval comes before every check**, and the run releases `github.sha` as it was at dispatch. Nothing compares it with `main` after the wait.                                                                  | The approver approves an unverified commit. A merge during the wait leaves staging on a commit that isn't `main`.   | Script in this change, plus patch A    |
| 3   | **Migrations run before the build**, with no backup step and no `migrate status` beforehand.                                                                                                                     | A later failure leaves the new schema under the old build.                                                          | Checklist below; patch B (status only) |
| 4   | **The stable alias moves at step 8**, before the auth journeys and the last smoke suite. The build that goes live is a second build, not the artefact the first smoke suite tested.                              | A failure in step 9 turns the run red and leaves staging on the new build. Nobody is told what to roll back to.     | Patch C                                |
| 5   | **No rollback step.** `staging-deploy-only.yml` records the previous deployment; this workflow doesn't. Rolling back by workflow is possible only to the commit pinned in `staging-deploy-only.yml` (`b129d41`). | Any other rollback target needs a reviewed re-pin PR, or a manual `vercel promote` that neither workflow documents. | Patch C; rollback section below        |

Two smaller points:

- `npm run test:e2e` retries twice in CI (`playwright.config.ts`), and several specs skip
  themselves when their preconditions are missing. A skip doesn't fail the run.
- The opt-in PostgreSQL suites are skipped inside `npm test` here. CI runs
  `invitation-seat-limit.postgres.test.ts` and `post-call-concurrency.postgres.test.ts` in its own
  job, which isn't one of the jobs `CI required` waits for.
  `invitation-accept-revoke.postgres.test.ts` runs nowhere.

## What this change adds

- **`scripts/verify-staging-candidate.ts`.** It fails unless all of these hold:
  - `CANDIDATE_SHA` is a full lowercase 40-character SHA;
  - `CONFIRM_STAGING_SHA`, typed by the operator, equals it;
  - it is the current tip of `main`;
  - a completed, successful `push` run of `ci.yml` exists for it on `main`.
- **`tests/unit/staging-candidate.test.ts`** (21 tests). A red, running, pull-request, manual,
  other-branch or other-commit CI run is refused. A moved `main` is refused before the CI query.
  A GitHub error fails closed and doesn't print the token.

The script is self-contained. `scripts/verify-release-chain.ts` has the same queries for
production, but it is protected configuration, so nothing is exported from it.

It isn't called by any workflow yet. Until patch A is applied, the release is exactly as before.

## Patches for the owner to apply

These edit `.github/workflows/staging-release.yml`. Each is independent.

### Patch A: verify the candidate before and after approval (gaps 1 and 2)

Add an input, a job that runs before the approval, and a re-check inside the gated job.

```yaml
on:
  workflow_dispatch:
    inputs:
      staging_project_ref:
        # unchanged
      confirm_sha:
        description: "Type the full 40-character main commit to release to staging"
        required: true
        type: string

permissions:
  contents: read
  actions: read # verify-staging-candidate.ts reads workflow runs

jobs:
  verify-candidate: # no environment: runs before anyone is asked to approve
    name: Verify the staging candidate
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
      - run: npm ci
      - name: Candidate is the typed commit, the tip of main, with green main CI
        run: npx tsx scripts/verify-staging-candidate.ts
        env:
          CANDIDATE_SHA: ${{ github.sha }}
          CONFIRM_STAGING_SHA: ${{ inputs.confirm_sha }}
          RELEASE_REPOSITORY: ${{ github.repository }}
          RELEASE_GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RELEASE_API_URL: ${{ github.api_url }}

  validate-migrate-deploy:
    needs: [verify-candidate]
    # ...unchanged, then as the first step after "Install dependencies":
    #   - name: Candidate is still the tip of main with green CI (after the approval wait)
    #     run: npx tsx scripts/verify-staging-candidate.ts
    #     env: (the same six variables)
```

Effect: the reviewer is asked to approve only after the first job is green, and a merge to `main`
during the wait stops the release before anything touches staging.

### Patch B: show pending migrations before applying them (gap 3)

Before "Apply Prisma migrations to staging" (line 135), add a step that prints what would run:

```yaml
- name: Show pending migrations (before applying)
  env:
    DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
    DIRECT_URL: ${{ secrets.STAGING_DIRECT_URL }}
  # Exit code 1 means "pending migrations exist", which is expected here.
  run: npx prisma migrate status || true
```

This is the one place where `|| true` is correct: the step is informational and the apply step
that follows is the gate. It doesn't replace a backup; see the checklist.

### Patch C: record the rollback target and say so on failure (gaps 4 and 5)

1. Before "Deploy validated candidate to the stable alias" (line 578), record the deployment the
   alias currently points at, as `staging-deploy-only.yml` lines 403–410 do, and fail if none is
   found.
2. After the last step, add:

```yaml
- name: Report the rollback target if a post-alias check failed
  if: failure() && steps.previous.outputs.deployment_id != ''
  run: |
    echo "::error::The stable staging alias serves the new build, and a check after the alias moved failed."
    echo "Previous deployment: ${{ steps.previous.outputs.deployment_id }}"
    echo "Roll back by promoting it, or dispatch staging-deploy-only.yml if it is the pinned commit."
```

An automatic rollback is deliberately not proposed. Promoting an older build under a schema that
has just been migrated is a decision for a person.

## Rollback today

| Target                                             | How                                                                                     | Needs a code change |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| The pinned commit in `staging-deploy-only.yml`     | Dispatch that workflow from `main`, type the pinned SHA, approve the Environment        | No                  |
| Any other earlier commit                           | A reviewed PR that re-pins `staging-deploy-only.yml`, then dispatch                     | Yes                 |
| The previous Vercel deployment, without rebuilding | `vercel promote <deployment>` with staging credentials; not documented for staging      | No                  |
| The database                                       | None. Migrations are additive and stay in place; a restore is a separate, approved step | —                   |

For the next release, the pinned commit is the build staging serves now, and the range from it to
`main` has no change under `prisma/`. A rollback would therefore be a dispatch, onto an unchanged
schema.

## Approval checklist for a staging release

Before approving the Environment:

- [ ] Main CI is green on the exact commit being released. Until patch A is applied, check this by
      hand: Actions → CI → the `push` run for that commit.
- [ ] No merge to `main` is in flight.
- [ ] The staging database has a recent backup or point-in-time recovery, confirmed in the Supabase
      dashboard. Required before any release that carries a migration.
- [ ] `git diff <currently released commit>..<candidate> -- prisma/` was read. If it isn't empty, the
      migrations were reviewed.
- [ ] The rollback target is known (table above).
- [ ] The Vercel Build Command for the staging project has no override
      (`docs/vercel-typecheck-check-cli-deployments.md`).

After the run:

- [ ] All 43 steps are green. A red run after step 8 means staging already serves the new build.
- [ ] `/api/health` on the stable alias reports the released commit.
- [ ] The e2e summary shows no unexpected skipped specs.

## Verified invariants (no change needed)

- **Node.js 22.** `package.json` `engines.node` is `22.x`, and every workflow sets
  `NODE_VERSION: "22"`. The build that is uploaded runs in the workflow, on Node 22.
- **Type-checking of prebuilt deployments** is pinned by
  `tests/unit/cli-deploy-typecheck-guard.test.ts`.
- **No silent bypass in the workflow.** There is no `continue-on-error`. The one `if: always()` is
  a cleanup step, and the one `|| true` tolerates a missing header inside a retry loop.
- **Branch rules.** `main` requires the `CI required` check and has no bypass actors. It doesn't
  require branches to be up to date, so a pull request's check can predate later merges. The `push`
  run on `main` after each merge is the evidence for the combined tree, which is what the new
  script checks.
