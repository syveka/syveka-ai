# Agent workflow: proposed configuration, awaiting human application

This directory is a **staging area**, not live configuration. Claude Code sub-agents are only
active when their files live in `.claude/agents/`. The repository's own guardrail hooks
(`.claude/hooks/config-protection.mjs`, `command-guard.mjs`, documented in
`docs/DEVELOPMENT.md` §12) deny the agent any write to `CLAUDE.md` and to `.claude/**`, which is
why the files were prepared here for a human to review and apply.

## Contents

| File                              | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `agents/orchestrator.md`          | Plans, delegates, runs CLAUDE.md §2, stops at §9 actions |
| `agents/implementer.md`           | Makes the smallest correct change plus a focused test    |
| `agents/code-reviewer.md`         | Read-only correctness and conventions review             |
| `agents/security-reviewer.md`     | Read-only tenant-isolation and security review           |
| `agents/test-runner.md`           | Runs the §3 validation suite, reports PASS/FAIL/N.A.     |
| `agents/db-migration-reviewer.md` | Read-only Prisma, migration and RLS review               |
| `agents/i18n-rtl-reviewer.md`     | Read-only fi/en/ar and RTL review                        |
| `agents/voice-flow-reviewer.md`   | Read-only Vapi voice-flow review                         |
| `CLAUDE.md.proposed-section.md`   | Two sections to insert into the root `CLAUDE.md`         |

Each agent file is a complete Claude Code sub-agent definition (YAML frontmatter with `name`,
`description`, `tools`, `model`, followed by its instructions) and can be copied as-is.

## How to apply (human, one of two ways)

**Option A, in a terminal on your machine** (PowerShell or Git Bash), from the repository root
on a review branch:

```bash
mkdir -p .claude/agents
```

```bash
cp docs/agent-workflow/agents/*.md .claude/agents/
```

Then paste the two sections from `CLAUDE.md.proposed-section.md` into `CLAUDE.md` at the
positions it names, run `npm run format:check`, review the diff, commit, and open a pull request.
Delete this `docs/agent-workflow/` directory in the same pull request once the files are live.

**Option B, let Claude Code do it under supervision.** Start a session with
`SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1` set in your own shell (see `docs/DEVELOPMENT.md` §12),
then ask Claude to move `docs/agent-workflow/agents/*.md` into `.claude/agents/` and insert the
proposed `CLAUDE.md` sections. The flag unlocks protected-config writes only; it never unlocks
secret reads, force pushes, pushes to `main` or deploys.

## Skills

No engineering skills were installed. The account's skill and plugin catalog (checked from the
session) exposes only document and productivity skills (docs, xlsx, pptx, pdf, docx, Google
Workspace, browser, research), none of the code-review, testing or framework skills a repository
workflow would use. Installing skills from `anthropics/skills` into `.claude/skills/` is also a
protected-config write and needs the same human step as above. The repository already ships one
project skill, `/verify` (`.claude/skills/verify/SKILL.md`), which `test-runner` relies on.

## Starting work with the orchestrator (once applied)

```
@orchestrator Add a per-organization daily cap on outbound voice calls, with a Vitest test.
```

The orchestrator inspects repo state, confirms scope, branches, delegates implementation and
parallel reviews, runs `test-runner`, reviews the diff, commits and pushes, then reports and waits.
It never merges or deploys; those remain your decisions, per CLAUDE.md §2 and §9.
