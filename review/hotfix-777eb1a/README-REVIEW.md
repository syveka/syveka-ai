# Review copy: production hotfix 777eb1a deployment preparation (PR #363)

This folder is a secret-free copy of the Windows preparation package
(`C:\Users\lenovo\Syveka-Recovery\2026-10-23\hotfix-777eb1a\`), published so it can be reviewed on
GitHub. It is evidence and documentation only.

- It is not application code, and this branch must never be merged or deployed.
- The application under review is still PR #363 at `777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5`.

Nothing was deployed, staged or promoted, and no production setting or secret changed.

## Contents

| Path                                                                           | What it is                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `HOTFIX-777eb1a-PREPARATION.md`                                                | The preparation document: validation summary, kit description, procedure, rollback, runbook gates, owner actions                  |
| `SHA256SUMS.txt`                                                               | Checksums of the **original** Windows package files (including the two excluded tarballs)                                         |
| `PUBLISHED-SHA256SUMS.txt`                                                     | Checksums of the files in this folder as published                                                                                |
| `kit/linux-build.sh`                                                           | Container build: pull, build as an unprivileged user, version checks, staged deploy with `--skip-domain`                          |
| `kit/common.ps1`                                                               | Shared constants (hotfix SHA, rollback target lfhr9ra1w / fc645727) and read-only checks                                          |
| `kit/stage1-build-and-stage.ps1`                                               | Stage 1: checks input hashes, runs the container build, records the staged URL                                                    |
| `kit/stage2-verify.ps1`                                                        | Stage 2: verifies the staged deployment (Ready/production; healthy, database ok, build 777eb1a)                                   |
| `kit/stage3-promote.ps1`                                                       | Stage 3: rollback-target gate, re-check, promote, verify both public hosts                                                        |
| `kit/stage4-rollback.ps1`                                                      | Stage 4: verifies, then promotes lfhr9ra1w back                                                                                   |
| `evidence/ci-linux.sh`, `ci-linux-777eb1a.log`, `ci-linux-777eb1a-results.txt` | **Corrected** clean-Linux validation run of 777eb1a (all steps rc=0 except the informational full audit)                          |
| `evidence/run1-superseded/*`                                                   | **Initial** run: 3 `health-route.test.ts` failures caused by the harness exporting `NEXT_PUBLIC_BUILD_SHA` into the test step     |
| `evidence/kit-checks-test.*`                                                   | The kit's pin and installed-version checks run against a real Linux install of the hotfix archive (pass; reject the old versions) |
| `evidence/kit-pin-negative.*`                                                  | The kit's pin check refusing the fc645727 source                                                                                  |
| `evidence/original-kit-hashes-before.txt`                                      | Hash prefixes proving the original recovery kit was left unchanged                                                                |

## Redactions (inspected before publishing)

| File                                                     | Redaction                                                                                    | Reason                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `kit/linux-build.sh` (1 line), `kit/common.ps1` (1 line) | Vercel project ID → `<REDACTED_VERCEL_PROJECT_ID>`, team/org ID → `<REDACTED_VERCEL_ORG_ID>` | The release workflow keeps these as GitHub secrets (`VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`) |

Because of this, these two files' hashes differ from `SHA256SUMS.txt`, which covers the unredacted originals the owner will run. Every other published file is byte-identical to the original; compare with `PUBLISHED-SHA256SUMS.txt`.

Kept intentionally:

- `postgresql://ci:ci@localhost:5432/ci`, the public placeholder that `ci.yml` itself uses for `prisma validate`. It is not a credential.
- Windows file paths.
- Public deployment hostnames already in PR #363.

Scanned with no matches:

- database URLs with real credentials, Supabase tokens (`sbp_`), Stripe keys, JWTs, bearer tokens, private keys;
- `auth.json` or token fields, email addresses, the production Supabase project ref.

## Excluded

- `kit/src.tar` and `evidence/src-777eb1a.tar` are the source archive of the commit itself. Reproduce and verify it:

  ```sh
  git archive --format=tar 777eb1a4c5f7c2d1eb59ce24f5ae4516944112d5 | sha256sum
  # 12e6f3b575ff02c6028dd6ddc78a4d86a3914aaf049a7a616b00ddc86e91da2d
  ```

- Nothing else from the package was excluded. The package never contained credentials, environment files, authentication files, database dumps or pulled production configuration. The kit pulls production config only inside a throwaway container at deploy time, deletes it with the container, and never writes it to the host.

## What to review

1. The kit diff against the 2026-10-23 recovery kit (SHA, archive, hashes, version gates, rollback gate, stage 4).
2. The corrected validation run and the explanation of the superseded one.
3. The runbook-exception analysis and the owner actions in `HOTFIX-777eb1a-PREPARATION.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
