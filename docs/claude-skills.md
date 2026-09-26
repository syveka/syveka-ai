# Claude Code Skills (Syveka)

Project skills live in `.claude/skills/<name>/SKILL.md`: YAML frontmatter plus Markdown, with
supporting files loaded on demand. Until a skill is invoked, only its `description` is in
context. Policy stays in `CLAUDE.md`; implementation reference stays in `docs/DEVELOPMENT.md`.

Expected benefit (not measured): fewer repeated instructions and less ad hoc loading of large
`docs/` files, because task-specific guidance loads only when a skill is used.

## Installed skills

| Skill                     | Purpose                                                                             | Invocation                                  |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `verify`                  | CLAUDE.md §3 validation suite, PASS/FAIL/NOT APPLICABLE                             | `/verify`, auto                             |
| `syveka-context`          | Compact architecture map + shared guardrails (`references/guardrails.md`)           | `/syveka-context`, auto                     |
| `syveka-debug`            | REPRODUCE → EVIDENCE → LAYER → HYPOTHESIS → VERIFY → PROPOSE FIX                    | `/syveka-debug <symptom>`, auto             |
| `syveka-pr-review`        | Syveka-specific PR review → BLOCKERS / IMPORTANT / OPTIONAL / VERDICT               | `/syveka-pr-review [PR]`, auto              |
| `syveka-security-review`  | Auth, RBAC, RLS, tenant isolation, webhooks, secrets, AI providers                  | `/syveka-security-review [PR]`, auto        |
| `syveka-e2e`              | Classify Playwright failures before fixing                                          | `/syveka-e2e <test>`, auto                  |
| `syveka-db-diagnostics`   | Prisma / pooler / 42P05 / DATABASE_URL vs DIRECT_URL, credentials masked            | `/syveka-db-diagnostics <error>`, auto      |
| `syveka-ai-cost`          | Cost estimation, model-tier selection, routing review; OpenRouter plan (notes only) | `/syveka-ai-cost <call site>`, auto         |
| `syveka-staging-audit`    | Read-only staging audit; EXPECTED vs SERVED SHA                                     | `/syveka-staging-audit [sha]`, user only    |
| `syveka-production-audit` | Read-only DOMAIN → ALIAS → DEPLOYMENT → SHA → RUNTIME → DB → REDIS chain            | `/syveka-production-audit <sha>`, user only |
| `syveka-release`          | Release **planning and verification** checklist with human gates (not execution)    | `/syveka-release <PR or sha>`, user only    |

"auto" = Claude may load it when the task matches its description. "user only" skills set
`disable-model-invocation: true`, so Claude cannot load them itself.

## What actually protects Syveka environments

The controls that protect production and staging are outside these skills: who holds Vercel,
Supabase, and database credentials; Claude Code permission rules and prompts; GitHub Environment
approvals (`staging`, `production`); branch protection and required CI; and the release
workflows' own SHA and project-identity checks. These remain essential. The skills add guidance
and a partial backstop on top; they are not an access-control boundary.

- **Skill instructions are behavioral guidance.** They tell Claude to stay read-only and stop at
  human gates. They do not technically prevent anything.
- **"User only" does not protect resources.** `disable-model-invocation` only controls who can
  load the skill's instructions. It does not restrict tools, credentials, or commands in the
  session.
- **No skill grants `allowed-tools`**, so tool calls still go through normal permission rules.

## The prod-guard hook (defense in depth)

Every `syveka-*` skill except `syveka-context` declares
`.claude/skills/syveka-context/scripts/prod-guard.mjs` as a `PreToolUse` hook for `Bash`,
`PowerShell`, and `mcp__github__*` tools.

**Lifetime.** Claude Code registers a skill's hooks when the skill is invoked, by a human or by
Claude auto-loading it, and keeps them for the rest of the session (Claude Code hooks
documentation, "Hooks in skills and agents"). They are not removed when the skill's turn ends,
and these skills do not use `once: true`. A fresh session starts without them. This includes
auto-loaded skills, so asking Claude to debug something can arm the guard without anyone typing a
slash command.

**What it rejects** (exit 2) when the command text matches these forms directly, optionally
behind env assignments, `npx`/`bunx`/`pnpm dlx`/`npm exec`/`yarn`, or `sudo`/`time`-style
wrappers:

- **Vercel:** any subcommand other than `ls`, `inspect`, `logs`, `whoami`, `help`, and
  `alias|env|domains|project|certs|dns ls`. This includes deploy, `--prod`, promote, rollback,
  alias set, env add/rm, and `env pull`.
- **Prisma and npm:** `prisma migrate deploy|dev|reset|resolve`, `prisma db push|execute|seed`,
  and `npm run db:migrate|db:deploy|db:seed`.
- **Supabase CLI:** `db push|reset`, `migration up|repair|squash`, `secrets set|unset`,
  `functions deploy|delete`, `link`, `config push`, and storage mutations.
- **psql:** a write or DDL keyword anywhere in the command text, or `-f` with a file other than
  the documented read-only assertion files.
- **git:** force, mirror, or delete pushes; pushes naming `main`/`master`; `reset --hard`,
  `clean -f`, branch deletion, `stash drop|clear`, and `filter-branch|filter-repo`.
- **gh:** `pr merge`, `workflow run|enable|disable`, secret/variable changes, release changes,
  and `api` calls with a mutating method.
- **HTTP:** `curl`/`wget` with a mutating method or body to Vercel, Supabase, Upstash/QStash, or
  Syveka hosts.
- **Secret exposure:** bare `env`/`printenv`/`set`, `echo`/`printf`/`printenv` of
  secret-named variables, and `cat`/`head`/`tail`/`less` of `.env*` files (except
  `.env.example`).
- **GitHub MCP:** `merge_pull_request`, `enable_pr_auto_merge`, `actions_run_trigger`, and
  `delete_file`.

**Known limitations.** The guard is regex matching over command text. It is not comprehensive
command or SQL enforcement:

- It does not see through indirection: `bash -c "…"`, `node -e`, `python -c`, shell scripts,
  `xargs`, aliases, functions, variables used as command names, `eval`, or quoted command text.
  Tests pin a few of these as known gaps.
- It only covers `Bash`, `PowerShell`, and GitHub MCP tools. Reading `.env` with the Read tool,
  writing a script with Write/Edit and then running it, and other MCP servers are not covered.
- SQL detection is keyword-based. It can miss writes (functions with side effects, `DO` blocks,
  `SELECT … FOR UPDATE`, obfuscated SQL) and can flag harmless text.
- PowerShell forms (`$env:NAME`, `Get-Content .env`) are only partly matched.
- Unparsable or command-less hook input exits 0, the same convention as the repo's other hooks.
  If the script cannot be started (for example, the hook's working directory is not the repo
  root), Claude Code treats that as a non-blocking hook error and the tool call proceeds.
- Matching can also over-block uncommon but harmless forms, such as `vercel --scope team ls`.

There is **no override**, by design. Do not add one or work around a block. The human runs an
authorized protected action.

`check-served-sha.mjs` is a read-only helper that only sends `GET /api/health`:
`node .claude/skills/syveka-context/scripts/check-served-sha.mjs <sha|-> <origin>...`.

The repo's existing hooks (`block-no-verify`, `config-protection`) are unchanged. The new scripts
are **not** on the `config-protection` list yet; adding them is a separate, authorized change.

## Using the skills around an authorized release

- The skills are for **diagnosis, review, auditing, and release planning or verification**.
  `syveka-release` arms the guard on purpose: it tracks and verifies each step, and humans perform
  every gated action (merge, workflow dispatch, Environment approval, migration, deploy, rollback).
- Because the guard lasts for the rest of the session, invoking any guarded skill (including by
  auto-load) means Claude cannot run blocked commands later in that session, even with explicit
  authorization. For an authorized action:
  1. The human runs it themselves (terminal or GitHub Actions UI). This is the preferred path.
  2. If Claude is explicitly authorized to execute a specific staging or production step, do it in
     a **separate session** where no `syveka-*` guarded skill has been invoked. Environment
     approvals and permissions still apply there.
- Do not disable the guard, edit the skill frontmatter, or reroute commands mid-session to get
  past a block.

## Human approval gates

Merge · production deployment · database migration · environment/secret changes · domain/alias
changes · workflow dispatch / GitHub Environment approval · user/org/membership changes ·
destructive operations. Skills are instructed to stop and print a `HUMAN GATE` block with the
exact command for the human to run. Approval is per action and per target, and never carries over
(CLAUDE.md §1, §9).

## Security rules for skills

- Never print secret values. Report shape only (presence, length, host suffix, port, param names).
- Staging is observe-only; production is strictly read-only.
- Parallelize only independent read-only work. Never parallelize git writes, migrations, deploys,
  or env/alias changes.
- Third-party skills are not installed without review (source, maintainer, full contents,
  scripts, network, credentials, hooks, auto push/merge/deploy). Prefer a Syveka-native skill.

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` with `name` and a specific `description` (what + when;
   under 1,536 characters together with `when_to_use`). Keep the body short. Put detail in sibling
   files and link them.
2. If it touches any environment, add the same `hooks:` block used by `syveka-debug` and link
   `../syveka-context/references/guardrails.md` instead of restating rules. Remember the
   hook lasts for the rest of the session.
3. Use `disable-model-invocation: true` for anything release-, staging-, or production-facing.
4. Avoid `allowed-tools` unless each rule is narrowly read-only.
5. Extend `tests/unit/hook-prod-guard.test.ts` when changing the guard, including any new known
   limitation, and run `/verify`.
