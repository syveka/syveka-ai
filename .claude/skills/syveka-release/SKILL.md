---
name: syveka-release
description: Deterministic Syveka release checklist from PR to post-deploy audit (PR → CI → merge authorization → main → staging → verify build SHA → E2E → staging approval → production authorization → deploy → verify served SHA → smoke → post-deploy audit) with explicit human gates. Tracks and verifies each step; never merges, dispatches workflows, migrates, or deploys itself. User-invoked only.
argument-hint: "[PR number | release SHA]"
disable-model-invocation: true
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-release

Release: `$ARGUMENTS`. Follow [guardrails](../syveka-context/references/guardrails.md). Source of
truth for procedure: `docs/release-runbook.md` (read the relevant section only when needed).

This is a **planning and verification** skill, not an execution skill. Claude **verifies and
reports**; humans perform every gated action. Stop at the first failed step.

It deliberately arms the prod-guard hook, which stays registered for the **rest of this session**.
Claude therefore cannot run merge, dispatch, migration, or deploy commands later in the same
session, even if authorized. The human runs them. Release execution by Claude requires an
explicitly approved execution policy and the normal permission/environment gates; changing
sessions is not authorization. Do not try to get past a block.

## Checklist

| #   | Step                   | Owner        | Verification Claude performs                                                                      |
| --- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| 1   | PR ready               | Claude       | `syveka-pr-review` verdict; no BLOCKERS                                                           |
| 2   | CI green on PR head    | Claude       | all required checks success on the exact head SHA                                                 |
| 3   | 🔒 MERGE AUTHORIZATION | **Human**    | record who authorized, which PR, which head SHA                                                   |
| 4   | Main tip = merged SHA  | Claude       | `git fetch origin main && git rev-parse origin/main`; main-push CI success for that SHA           |
| 5   | 🔒 Staging dispatch    | **Human**    | _Staging release validation_ run from `main` at that SHA (includes staging migration)             |
| 6   | Staging SHA served     | Claude       | `check-served-sha.mjs <sha> https://syveka-ai-staging.vercel.app` → PASS                          |
| 7   | Staging E2E            | Claude       | smoke + auth-journey steps success; failures → `syveka-e2e`                                       |
| 8   | 🔒 STAGING APPROVAL    | **Human**    | `syveka-staging-audit` report reviewed and accepted                                               |
| 9   | Prod preflight         | Claude       | backup/PITR confirmation recorded by human; pending migrations listed; `npm run migrations:check` |
| 10  | 🔒 PRODUCTION AUTH     | **Human**    | Ehab authorizes this SHA; dispatches _Production release_ (SHA twice); approves `production` env  |
| 11  | Deploy + promote       | Workflow     | release run success; promotion step shows both domains → candidate                                |
| 12  | Served SHA             | Claude       | `check-served-sha.mjs <sha> https://syveka.com <PROD_URL>` → PASS                                 |
| 13  | Smoke                  | Claude/Human | runbook "Production smoke checklist"; mark each item                                              |
| 14  | Post-deploy audit      | Claude       | `syveka-production-audit <sha>`                                                                   |

🔒 = HUMAN GATE. Additional gates whenever they arise: **database migration**, **environment
changes**, **domain/alias changes**, **destructive operations**, **rollback**.

## Rollback

Prefer application rollback (previous known-good immutable SHA). The production workflow prints the
exact `vercel rollback <deployment>` command on failure — surface it to the human; never run it.
Never edit `_prisma_migrations`, drop objects, or disable RLS as rollback.

## Output

Print the checklist with each row: ✅ verified (evidence) · ⏳ waiting on human · ❌ failed (root
cause) · ⏭ not applicable (why). End with the single next action and who owns it.
