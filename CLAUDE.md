# Syveka AI — Engineering Charter (v1.0)

This document defines the permanent operating rules and engineering principles for this
repository. It applies to every contributor, human or AI, and to every session. Unlike
project-status documents (roadmaps, handoffs, audit reports), nothing in this file expires —
if a rule here stops being true, update this file deliberately rather than letting it drift.

Project-status information (current branch, open PRs, active findings, CI runs, dates, roadmap
items) does not belong here. Always verify live state (`git status`, `git log`, `gh pr list`,
`gh run list`) rather than trusting cached documentation or memory — docs and prior context are
snapshots, not a live feed.

## 1. Safety & Approval Rules (non-negotiable)

These rules override convenience, speed, or a plausible-sounding justification. When in doubt,
stop and ask rather than proceed. The full list of actions that always require explicit
authorization is in §9 (Protected Actions) — treat it as part of this section.

- **Never take an irreversible or wide-blast-radius action without explicit authorization.** A
  prior approval for one instance of an action is not standing approval for future instances,
  and silence is never consent.
- **Preserve all existing work.** Never delete, move, overwrite, or clean uncommitted changes,
  untracked files, or generated/output artifacts that fall outside the current task's explicit
  scope, without explicit instruction. When uncommitted work is discovered unexpectedly,
  investigate before touching it — it may be in-progress work worth keeping.
- **Investigate unfamiliar state before acting on it.** A lock file, an unexpected branch, or an
  unfamiliar file may represent someone else's in-progress work; prefer a reversible action
  (stash, rename, move aside) over a destructive one.
- **Fix only proven problems.** Do not guess at root causes, and do not make speculative
  changes, broad refactors, or architectural rewrites to "improve" something that wasn't asked
  for.

## 2. Explicit Engineering Workflow

Every task that changes code follows this sequence, in order:

1. Inspect repository state (branch, working tree, recent history, relevant CI/PR state).
2. Confirm the authorized task and its scope before writing any code.
3. Create a dedicated branch.
4. Implement the smallest correct change that resolves the confirmed task.
5. Run focused validation (the specific test/check that proves the change works).
6. Run the applicable full verification suite (§3).
7. Review `git diff` and `git diff --staged` in full.
8. Confirm no unrelated changes and no secrets are present in the diff.
9. Commit with a focused message describing the change and why.
10. Push the branch.
11. Open a pull request.
12. Report branch, commit, PR link, files changed, tests run, risks, and CI status.
13. Wait for explicit human authorization before merging.
14. Treat deployment as a separate protected action requiring its own separate authorization,
    even after a merge is authorized.

Explicit rules that apply throughout this sequence:

- Never commit directly to `main`.
- Never push directly to `main`.
- Never merge without explicit authorization for that specific change.
- Never treat authorization to merge as authorization to deploy.
- Never start the next task automatically — stop and report after each protected step.

## 3. Required Validation Commands

Confirm the exact commands from `package.json` before running them — script names can change.
As of this writing, the relevant scripts are:

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run i18n:check` — for any change touching translations or locale-visible strings
- `npm run migrations:check` — for any change touching the database schema or migrations
- `npm run build` — whenever the change could affect production compilation
- Relevant focused Vitest tests for the specific change
- `npm run test:e2e` (or the relevant Playwright smoke tests) — for authentication, API,
  routing, deployment, or other critical user-flow changes

Rules:

- Report every command that was run as **PASS**, **FAIL**, or **NOT APPLICABLE** — never omit
  one silently.
- Never claim a check passed unless it actually ran and completed successfully.
- Never weaken, skip, delete, or disable a test to make validation or CI pass without explicit
  authorization.
- If validation fails, stop and report the failure with its root cause. Do not bypass, retry
  into a different codepath, or paper over a failing check to force a pass.

## 4. Multi-Tenant & Security Architecture Principles

These are lessons this codebase has already paid for — treat them as settled, not open
questions:

- **Tenant isolation is enforced and verified at the application layer**, derived from a
  server-verified session/identity context — never from a client-supplied org or user
  identifier. Database-level protections are defense in depth, not a substitute for this.
- **Fail closed, never fail open, on missing or invalid security-sensitive configuration**
  (signing secrets, encryption keys, auth tokens). A hardcoded or silently-defaulted fallback for
  a secret is a vulnerability, not a convenience — throw a clear configuration error instead.
- **Validate environment configuration per integration, not monolithically.** A client that only
  needs three environment variables should validate exactly those three, independently of every
  other integration's configuration. Coupling unrelated integrations to one all-or-nothing
  schema check means one team's unrelated misconfiguration silently breaks another team's
  feature.
- **Rate-limit every state-changing, cost-amplifying, or publicly-reachable endpoint**,
  consistently, using the shared limiting infrastructure — not ad hoc, per-route judgment calls.
- **Never leak secrets, internal errors, or stack traces into responses, logs, or client-visible
  output.** Sanitize before surfacing.

## 5. Product Engineering Principles

- **AI-first.** Default to AI-augmented workflows and automation where they genuinely improve
  outcomes — don't force AI into places it doesn't help.
- **Automation-first.** Prefer automating repeatable operational work (CI, checks, deployment
  gates) over manual, error-prone steps.
- **Business-first.** Technical decisions serve the product and its users; technology choices are
  justified by business value, not novelty.
- **Security-first.** Security and tenant-data protection take priority over convenience,
  velocity, or elegance.
- **Simplicity over complexity.** Choose the simplest design that correctly and durably solves
  the problem at hand.
- **Small, focused changes.** Prefer narrow, independently reviewable changes over broad,
  multi-purpose ones.
- **Long-term maintainability.** Optimize for the next person who reads this code, not just the
  current deadline.
- **Multi-tenant by default.** Every feature is designed for tenant isolation and correctness
  from the start, not retrofitted later.
- **Provider-agnostic architecture whenever practical.** Avoid tight coupling to a single
  vendor's API where a reasonable abstraction exists and the cost is justified.
- **Avoid vendor lock-in.** Prefer replaceable integrations and standard interfaces over
  proprietary extensions when the trade-offs allow it.
- **Reusable, modular components.** Build shared building blocks instead of duplicating logic
  across the codebase.
- **Explain trade-offs before major architectural decisions.** Any significant architecture
  change is preceded by a clear statement of the alternatives considered and why the chosen path
  won, not presented as the only option.

## 6. Syveka Product Philosophy

- Build production products, not demos.
- Solve real business problems.
- AI should automate meaningful work, not merely add chat.
- Every feature must improve customer value, revenue potential, efficiency, retention, or
  defensibility.
- Prefer scalable SaaS architecture.
- Design globally and multilingual from the start where practical.
- Avoid feature bloat.
- Challenge weak ideas and unnecessary complexity — agreement is not the default response.
- Preserve modularity so capabilities can become reusable Syveka business applications, not
  one-off features locked to a single product surface.

## 7. AI Development Principles

- **Never hardcode prompts** where they can't be reviewed, versioned, or updated independently of
  application code. Prefer configurable, structured prompt templates.
- **Keep AI providers replaceable whenever practical.** Avoid provider-specific assumptions
  leaking into business logic; isolate provider calls behind a stable interface.
- **Fail safely if an AI provider is unavailable or degraded.** Degrade gracefully with a clear
  error — never silently corrupt data, hang indefinitely, or block core functionality without
  explanation.
- **Never expose user conversations, prompts, or any secret material** to logs, third parties, or
  unintended recipients.
- **Preserve privacy.** Minimize retention and exposure of personal or sensitive data sent to or
  returned from AI providers; only send what a feature genuinely needs.
- **Avoid model-specific assumptions** (context window size, output format, latency
  characteristics) unless explicitly approved for that specific integration.

## 8. Code Quality Principles

- Write readable code; prioritize clarity over cleverness.
- Use descriptive, intention-revealing names for variables, functions, and files.
- Keep technical debt minimal, and address it deliberately rather than letting it accumulate
  silently.
- Add comments only where the *why* isn't obvious from the code itself — never narrate *what*
  well-named code already shows.
- Avoid premature optimization; optimize only where there is a measured, real need.
- Avoid unnecessary abstraction; don't build for hypothetical future requirements that may never
  arrive.
- Preserve backward compatibility unless a breaking change is explicitly approved.

## 9. Protected Actions Requiring Explicit Authorization

Every action below requires explicit authorization for that specific instance. Previous
approval, silence, or broad repository access is never standing approval.

- Writing or materially changing this file (`CLAUDE.md`)
- Direct push to `main`
- Merging a pull request
- Deployment or workflow dispatch
- GitHub Environment approval
- Production configuration changes
- Secret modification or rotation
- Destructive database commands
- Force-push or history rewriting
- Branch deletion
- Dependency upgrades outside the authorized task's scope
- Public API, schema, migration, or environment-contract changes outside the approved scope
- Branch protection, ruleset, repository permission, CI policy, or workflow-policy changes
- Deleting, overwriting, cleaning, or moving user files, untracked work, or generated artifacts

## 10. Task Completion Checklist

- [ ] Repository, branch, and working tree verified
- [ ] Authorized task only
- [ ] No scope expansion
- [ ] Minimal diff
- [ ] All modified files listed and reviewed
- [ ] `git diff` and `git diff --staged` inspected
- [ ] No unrelated files changed
- [ ] No secrets exposed
- [ ] Relevant validation executed
- [ ] Results reported accurately
- [ ] No tests weakened or bypassed
- [ ] No tenant, RLS, RBAC, auth, rate-limit, or audit control weakened
- [ ] No unauthorized merge, deployment, environment approval, or production action
- [ ] Risks, failures, and assumptions disclosed
- [ ] Waiting for human authorization before the next protected action
