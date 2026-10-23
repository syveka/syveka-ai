# Production security hotfix 777eb1a: preparation package (for OLD's review)

Status: **PREPARED, NOT DEPLOYED.** Nothing has been merged, deployed or promoted, and no production setting or secret has changed. Production serves `fc645727` on `syveka-ai-production-lfhr9ra1w`.

| Item                        | Value                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PR                          | https://github.com/syveka/syveka-ai/pull/363 (draft; base `prod-base/fc645727` = fc645727)                       |
| Head (code-approved by OLD) | `777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5`                                                                       |
| Parent                      | `fc645727cc8f0932f90c793667d8cfe3de0b35d3` (live production)                                                     |
| Change                      | `package.json` + `package-lock.json` only: next 15.5.28, sharp 0.35.5 (override), source-map-js 1.2.2            |
| Source archive              | `kit/src.tar` = `git archive 777eb1a`, sha256 `12e6f3b575ff02c6028dd6ddc78a4d86a3914aaf049a7a616b00ddc86e91da2d` |
| Rollback target             | `https://syveka-ai-production-lfhr9ra1w-syveka-ai.vercel.app` (build fc645727, rotated DB credential)            |

## 1. Independent clean-Linux validation of 777eb1a

- `evidence/ci-linux.sh`: the script, credential-free and DB-free, with every step's exit code recorded.
- `evidence/ci-linux-777eb1a.log` and `evidence/ci-linux-777eb1a-results.txt`: the output, tied to the SHA and the tar hash.

Environment: `node:22-bookworm` (Node 22, glibc x86_64), a fresh container, no bind mounts, the archive copied in. It mirrors the `ci.yml` Node jobs that apply to a dependency-only change.

The PR base was **not** changed to `main`. GitHub CI does not run on this PR, so this run substitutes for it.

Result (`ci-linux-777eb1a-results.txt`; all rc=0 except the informational full report):

```
npm ci                             rc=0      installed: next 15.5.28, sharp 0.35.5 (1 copy; runtime sharp 0.35.5, vips 8.18.7),
installed versions                 rc=0                 @img/sharp-linux-x64 0.35.5, libvips 1.3.4, source-map-js 1.2.2
production audit (gate)            rc=0      found 0 vulnerabilities
full audit report (info only)      rc=1      includes dev deps (react-email's nested next 15.1.2 etc.); ci.yml runs it with continue-on-error
prisma generate / validate         rc=0
migrations:check                   rc=0
format:check / lint / typecheck    rc=0
i18n:check                         rc=0
test                               rc=0      162 files, 1577 tests (4 skipped)
build                              rc=0      Next.js 15.5.28, 145 static pages
health route carries SHA           rc=0      777eb1a… inlined
```

The first run, kept in `evidence/run1-superseded/`, had 3 failures in `health-route.test.ts`. The cause was the harness: it exported `NEXT_PUBLIC_BUILD_SHA` for every step, and those tests expect `build: "unknown"` when the variable is unset; ci.yml's test job doesn't set it. The corrected script sets it only for the build step. The code is unchanged between the runs.

Kit check tests (credential-free):

- `evidence/kit-checks-test.log`: the kit's pin and installed-version checks pass on a real Linux install of `kit/src.tar`, and reject the old versions.
- `evidence/kit-pin-negative.log`: the pin check stops on the fc645727 source.

Not run, because they don't apply to a dependency-only change: the RLS/migration jobs that need Postgres (no schema or migration change; they passed on fc645727), Playwright e2e, live-provider tests and Strix.

## 2. Deployment kit for the hotfix (`kit/`)

This is a separate copy of the 2026-10-23 recovery kit (`..\linux-recovery`). The original is unchanged; its file hashes match `evidence/original-kit-hashes-before.txt`.

| File                         | sha256            | Change from the recovery kit                                                                                                                                                                                                                                |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src.tar`                    | `12E6F3B5…91DA2D` | archive of 777eb1a (was fc645727)                                                                                                                                                                                                                           |
| `linux-build.sh`             | `BC05E5D1…3CB107` | `SHA=777eb1a…`; refuses unless `package.json` pins `next ^15.5.28` and `sharp 0.35.5`; after `npm ci`, refuses unless installed `next 15.5.28`, `sharp 0.35.5` (one copy, linux-x64 binary 0.35.5) and `source-map-js 1.2.2`; login hint says vercel@56.3.2 |
| `common.ps1`                 | `F3F1BC1D…0C8516` | `$Sha = 777eb1a…`; `$RollbackUrl`/`$RollbackSha` (lfhr9ra1w / fc645727); `Get-LiveDeploymentUrl` (read-only `vercel inspect syveka.com`); health checks take an expected SHA                                                                                |
| `stage1-build-and-stage.ps1` | `42CE6941…8FF5F2` | expected hashes of `src.tar` and `linux-build.sh` above; container `syveka-hotfix-build`                                                                                                                                                                    |
| `stage2-verify.ps1`          | `9BE693F7…FF1A96` | unchanged (uses `$Sha` = 777eb1a)                                                                                                                                                                                                                           |
| `stage3-promote.ps1`         | `A8FEBB8C…A871DC` | new gate: refuses unless syveka.com still serves lfhr9ra1w and both hosts are healthy on fc645727; failure text points to stage 4                                                                                                                           |
| `stage4-rollback.ps1`        | `8B669247…2FB27A` | new: checks lfhr9ra1w (Ready, healthy, database ok, build fc645727), promotes it and verifies both hosts                                                                                                                                                    |

All five PowerShell files parse with 0 errors. `linux-build.sh` passes `bash -n` and has LF line endings. The deny-class steps (Vercel pull, deploy, promote) run only in **your own** PowerShell window. The kit never takes a credential as an argument; your Vercel login is copied into the throwaway container (root-only) and deleted with it.

## 3. Procedure (documentation; nothing executed)

**No migrations.**

- `deploy.yml` is not used: it runs `prisma migrate deploy` and only deploys the `main` tip.
- The build is `prisma generate && next build`, with no install or build hooks; `linux-build.sh` checks this and stops otherwise.
- Production still has migration `20261014000000_secure_prisma_migrations_table` pending (runbook note of 2026-10-21). This hotfix must not apply it, and it doesn't.

1. **Stage 1 (build and stage):** fresh Linux build of 777eb1a with `NEXT_PUBLIC_BUILD_SHA=777eb1a…`, then `deploy --prebuilt --prod --skip-domain`. The production alias does not move.
2. **Stage 2 (verify, read-only):** the staged deployment must be Ready with target production, and `/api/health` must report `healthy`, `database ok` and `build 777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5` (through `vercel curl`, which bypasses deployment protection without printing the secret).
3. **Stage 3 (promote):**
   - confirm syveka.com still serves lfhr9ra1w and both hosts are healthy on fc645727;
   - re-check the staged deployment;
   - promote it;
   - both hosts must return 200, healthy, database ok and build 777eb1a within 3 minutes;
   - then monitor runtime logs for 10 minutes: no database errors, no 5xx.
4. **Stage 4 (rollback, only if needed):** check lfhr9ra1w, then promote it and verify fc645727 on both hosts.
   - Never use 9fjraopmr, qsc3ojpkl or anything older: those hold the revoked password and return 503.
   - Before promotion, nothing needs rolling back: an unpromoted staged deployment never serves traffic.

No database or secret changes at any step. New deployments read the current production env, which already holds the rotated credential.

## 4. Runbook gates (`docs/release-runbook.md`) for a dependency-only security fix

The runbook's production path is: dispatch "Production release" from `main` (tip SHA, main-push CI, staging run), then approve the GitHub `production` Environment, then `prisma migrate deploy`, then build/stage/verify/promote. That path **cannot** deliver this hotfix without shipping main's 194 commits and running migrations. Delivering 777eb1a is therefore an **exception to the runbook**, the same mechanism as the 2026-10-23 recovery.

| Runbook gate                                                                                                                                            | Applies?                                                                       | Status for 777eb1a                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release from the `main` tip via `deploy.yml`, release-chain verifier                                                                                    | No: by design                                                                  | Replaced by the owner-run kit; recorded as an exception                                                                                                                                                                               |
| Main-push CI + staging workflow run at the exact SHA                                                                                                    | Not as written (SHA isn't on main; staging workflow deploys main + migrations) | Substitutes: OLD code review of 777eb1a; local checks; the independent clean-Linux run (§1); the Vercel staging and production Preview builds of the branch passed. Optional: a manual smoke of the Vercel staging Preview of 777eb1a |
| GitHub `production` Environment approval                                                                                                                | Not reachable (no workflow)                                                    | Replaced by your explicit written authorization naming SHA `777eb1a…` (below)                                                                                                                                                         |
| Backup / PITR (Option A, B, B-M)                                                                                                                        | Its purpose is database recovery; this change writes nothing to the database   | Recommend recording the current PITR / daily-backup status in the change record. Not required for a database rollback, since there is none                                                                                            |
| Migration preflight, `migrate status`, `release-invariants.sql`, `004_storage.sql`                                                                      | No: no migration                                                               | Must **not** run (it would apply the pending migration)                                                                                                                                                                               |
| Recorded application rollback target (Option B item 3)                                                                                                  | Yes                                                                            | lfhr9ra1w, gated live and healthy in stage 3; stage 4 rolls back to it                                                                                                                                                                |
| Named rollback owner for the window                                                                                                                     | Yes                                                                            | **You must name one**                                                                                                                                                                                                                 |
| Build the immutable SHA; `NEXT_PUBLIC_BUILD_SHA`; staged `--skip-domain`; health check through protection bypass; explicit promote; verify both domains | Yes                                                                            | Built into stages 1–3                                                                                                                                                                                                                 |
| Production smoke checklist after promotion                                                                                                              | Yes                                                                            | You (health plus a quick sign-in and dashboard check), plus 10-minute log monitoring                                                                                                                                                  |
| Schema write freeze                                                                                                                                     | No: no schema change                                                           | A short notice of the deploy window is enough                                                                                                                                                                                         |
| Secrets in logs/PRs; no `.env` or backups committed                                                                                                     | Yes                                                                            | Kept: no secrets in the kit, the logs or the PR                                                                                                                                                                                       |

## What remains for you before and during deployment

1. **OLD's review** of this package: the kit diff against the recovery kit, the Linux results and these gates.
2. **Written authorization** naming SHA `777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5`, PR #363, and that this runbook exception is accepted (no workflow, no migrations, rollback to lfhr9ra1w).
3. **A named rollback owner** and a deploy window. Optionally, record the PITR/backup status.
4. **Run stages 1–3 yourself** in your own PowerShell window. The repository guard blocks the agent from Vercel pull, deploy and promote, and the agent will not route them through `!` or another session.
5. **Afterwards:** the smoke check; and stage 4 only if the hosts fail. Claude can do the read-only 10-minute health and log monitoring.
6. **Separately (not part of this deploy):** decide on #361 for main, the remaining owner cleanup steps (1b onward), and MFA.
