# Vercel "TypeCheck" check fails on CLI deployments (2026-11-10)

**Summary.** On the `syveka-ai-staging` Vercel project, the Vercel-native **TypeCheck** deployment
check fails on every deployment made by the staging workflows (`staging-release.yml`,
`staging-deploy-only.yml`). The code has no type error. The
check cannot run on those deployments, because a `vercel deploy --prebuilt` upload has no
`tsconfig.json`. Git-integration Preview builds pass the same check. The check is not required,
so it has never blocked a promotion. The fix is a dashboard setting (below). The repository
change is a regression test that pins what does type-check those deployments.

## Evidence

All of this was read-only, from the Vercel dashboard and API, on 2026-11-10.

**Check configuration**

- Location: Project → Settings → Build and Deployment → Deployment Checks.
- Two checks: **Lint** and **TypeCheck**, provider "Vercel" (`vercel-native-check`, jobs `lint`
  and `typecheck`), each on Preview and Production.
- Every run reports `requires: none, blocks: none`.

**Command and directory**

- The check runs `bash -c npm run typecheck`, which is `tsc --noEmit`, in the deployment's own
  file set.
- Root Directory is empty, meaning the repository root.

**The failing run** (current staging alias, `b129d416`, deployment `dpl_EaCB1TUtg…`, source
"CLI", from `staging-deploy-only.yml` on 2026-11-03)

- TypeScript 5.9.3 printed its help text, beginning "Compiles the current project (tsconfig.json
  in the working directory.)".
- It then printed `Exited with code 1.`

**What that deployment contains**

- `.env.example`, `.next/`, `.vercel/output/`, `emails/`, `node_modules/`, `package.json` and a
  partial `src/` (only the files Next traced).
- **No `tsconfig.json`.** The `.vercel/` directory holds only build output, so no pulled
  environment file was uploaded.

**Reproduced locally:** `tsc --noEmit` with TypeScript 5.9.3, in a directory without
`tsconfig.json`, prints the same help text and exits 1. At the repository root it compiles and
exits 0.

**All 221 TypeCheck runs on the project** (2026-09-26 to 2026-11-10; the CLI failures span
2026-10-25 to 2026-11-03)

| Deployment source                                                          | Target     | TypeCheck                                                                                                                             |
| -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Git integration (branch push)                                              | Preview    | 194 passed, 2 skipped, 1 canceled, 1 failed with a real type error (exit 2, branch `ci/staging-deploy-only-pin-62af063`, since fixed) |
| CLI `deploy --prebuilt` (`staging-release.yml`, `staging-deploy-only.yml`) | Production | **15 of 15 failed** (help text, exit 1)                                                                                               |
| CLI `deploy --prebuilt` (`staging-release.yml` candidate)                  | Preview    | **8 of 8 failed**                                                                                                                     |

## Root cause

- **What Vercel's docs say:** script-based native checks "clone your repository, install
  dependencies, and run the corresponding script"
  ([Deployment Checks](https://vercel.com/docs/deployment-checks)).
- **Why that doesn't apply here:** a CLI `--prebuilt` deployment has no Git source to clone. The
  check runs in the uploaded files instead, which are the build output, `package.json` and the
  traced runtime files.
- **Why that fails:** Next.js does not trace `tsconfig.json`, because nothing reads it at
  runtime. `npm run typecheck` resolves, but `tsc` finds no project and prints its help.

## What does type-check those deployments (pinned by `tests/unit/cli-deploy-typecheck-guard.test.ts`)

- **`vercel build` runs a full `next build`, which fails on a type error before anything is
  uploaded.**
  - The `build` script is `prisma generate && next build`, with no `--experimental-build-mode`.
  - There is no `vercel-build` script, `vercel.json` sets no `buildCommand`, and `next.config.ts`
    doesn't set `typescript.ignoreBuildErrors`.
- **Every `deploy --prebuilt` follows a `vercel build` in the same job.** That holds in
  `staging-release.yml`, `staging-deploy-only.yml` and `deploy.yml`.
- **`staging-release.yml` also runs `npm run typecheck` before its first deployment.** Its single
  checkout comes before that typecheck, so the typecheck and the deployment use the same code.

Two things back this up that the test does not pin:

- `main` requires the `CI required` check, which includes the "TypeScript typecheck" job.
- **Not pinned, and unverified:** the Vercel dashboard's Build Command (Build and Deployment →
  Framework Settings) must stay at its default. `vercel pull` brings that setting into the
  workflow, and an override would replace the `build` script. The repository cannot check it.

## Fix: an owner decision in the Vercel dashboard

Nothing in the repository can make this check pass on a prebuilt upload without bypassing it.
Adding `tsconfig.json` to the traced files would only produce a check over a partial `src/`.
Choose one:

1. **Recommended: remove the native TypeCheck and Lint checks** on `syveka-ai-staging`.
   - They are informational (`blocks: none`).
   - They duplicate the required GitHub `CI required` check, which runs both lint and typecheck.
   - TypeCheck fails on every staging release. Lint is skipped on Git-integration previews.
2. **Keep them and treat a CLI-deployment TypeCheck failure as expected.** It says nothing about
   the code. A failure on a Git-integration Preview is still a real signal.
3. **Replace them with a GitHub-check deployment check** on `CI required`. It is unverified
   whether Vercel links GitHub checks to CLI deployments, so try it on one release first.

Moving the checks to Production only does not help: the CLI Preview deployments of
`staging-release.yml` fail too.
