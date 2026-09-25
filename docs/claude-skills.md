# Claude Code Skills (Syveka)

Project skills live in `.claude/skills/<name>/SKILL.md` (Claude Code 2.x format: YAML frontmatter

- Markdown; supporting files load on demand). Only each skill's `description` sits in context
  until the skill is invoked, so skills replace repeated prompt instructions without growing
  `CLAUDE.md`. Policy stays in `CLAUDE.md`; implementation reference stays in `docs/DEVELOPMENT.md`.

## Installed skills

| Skill | Purpose | Invocation |
| ------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- | ----------------- |
| `verify` | CLAUDE.md §3 validation suite, PASS/FAIL/NOT APPLICABLE | `/verify`, auto |
| `syveka-context` | Compact architecture map + shared guardrails (`references/guardrails.md`) | `/syveka-context`, auto |
| `syveka-debug` | REPRODUCE → EVIDENCE → LAYER → HYPOTHESIS → VERIFY → PROPOSE FIX | `/syveka-debug <symptom>`, auto |
| `syveka-pr-review` | Syveka-specific PR review → BLOCKERS / IMPORTANT / OPTIONAL / VERDICT | `/syveka-pr-review [PR]`, auto |
| `syveka-security-review` | Auth, RBAC, RLS, tenant isolation, webhooks, secrets, AI providers | `/syveka-security-review [PR]`, auto |
| `syveka-e2e` | Classify Playwright failures before fixing | `/syveka-e2e <test>`, auto |
| `syveka-db-diagnostics` | Prisma / pooler / 42P05 / DATABASE_URL vs DIRECT_URL, credentials masked | `/syveka-db-diagnostics <error>`, auto |
| `syveka-ai-cost` | Cost estimation, model-tier selection, routing review; OpenRouter plan (notes only) | `/syveka-ai-cost <call site>`, auto |
| `syveka-staging-audit` | Read-only staging audit; EXPECTED vs SERVED SHA | `/syveka-staging-audit [sha]` (user only) |
| `syveka-production-audit` | Strictly read-only DOMAIN → ALIAS → DEPLOYMENT → SHA → RUNTIME → DB → REDIS chain | `/syveka-production-audit <sha>` (user only) |
| `syveka-release` | Deterministic release checklist with human gates | `/syveka-release <PR                         | sha>` (user only) |

"auto" = Claude may load it when the task matches its description. **User only** skills set
`disable-model-invocation: true`: they never load unless a human types the command.

## Permissions and technical backstop

- No skill grants `allowed-tools`; every tool call goes through normal permission prompts.
- Every `syveka-*` skill except `syveka-context` registers
  `.claude/skills/syveka-context/scripts/prod-guard.mjs` as a `PreToolUse` hook. Once invoked, it
  stays active for the session and blocks: Vercel deploy/promote/rollback/alias/env changes and
  `env pull`; `prisma migrate deploy|dev|reset|resolve` and `db push|execute|seed`; `npm run
db:migrate|db:deploy|db:seed`; Supabase `db push|reset`, secrets, function deploys; `psql` write
  or DDL statements and non-allowlisted `-f` files; force/delete pushes and pushes to `main`;
  `reset --hard`, `clean -f`, branch deletion, history rewrites; `gh pr merge`, workflow dispatch,
  secret/variable changes, mutating `gh api`; mutating HTTP calls to Vercel/Supabase/Upstash/
  Syveka; environment dumps, printing secret-named variables, and reading `.env` files; GitHub MCP
  merge, auto-merge, workflow dispatch, and file deletion. There is **no override**: an authorized
  protected action is run by the human.
- `check-served-sha.mjs` is a read-only helper (`GET /api/health` only):
  `node .claude/skills/syveka-context/scripts/check-served-sha.mjs <sha|-> <origin>...`.
- Existing repo hooks (`block-no-verify`, `config-protection`) are unchanged and still apply.

## Human approval gates

Merge · production deployment · database migration · environment/secret changes · domain/alias
changes · workflow dispatch / GitHub Environment approval · user/org/membership changes ·
destructive operations. Skills stop and print a `HUMAN GATE` block with the exact command for the
human to run. Approval is per action, per target, and never carries over (CLAUDE.md §1, §9).

## Security rules for skills

- Never print secret values; report shape only (presence, length, host suffix, port, param names).
- Staging is observe-only; production is strictly read-only.
- Parallelize only independent read-only work; never parallelize git writes, migrations, deploys,
  env or alias changes.
- Third-party skills are not installed without review (source, maintainer, full contents,
  scripts, network, credentials, hooks, auto push/merge/deploy). Prefer a Syveka-native skill.

## Adding a skill

1. Create `.claude/skills/<name>/SKILL.md` with `name` and a specific `description` (what + when;
   under 1,536 chars with `when_to_use`). Keep the body short; put detail in sibling files and link
   them.
2. If it touches any environment, add the same `hooks:` block used by `syveka-debug` and link
   `../syveka-context/references/guardrails.md` instead of restating rules.
3. Use `disable-model-invocation: true` for anything release-, staging-, or production-facing.
4. Avoid `allowed-tools` unless each rule is narrowly read-only.
5. Extend `tests/unit/hook-prod-guard.test.ts` when changing the guard, and run `/verify`.
