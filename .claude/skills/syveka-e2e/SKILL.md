---
name: syveka-e2e
description: Diagnose Syveka Playwright E2E failures (auth journeys, onboarding, organizations, bookings, CRM, AI assistant, Creator Studio, Voice/Vapi, staging aliases). Classifies each failure as APPLICATION BUG / TEST BUG / ENVIRONMENT PROBLEM / NETWORK-PROVIDER FAILURE / CONFIGURATION DRIFT / FLAKY TEST before proposing the smallest verified fix. Use when an E2E test, smoke gate, or staging-release Playwright step fails.
argument-hint: "[failing test name | workflow run URL | spec file]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-e2e

Failure: `$ARGUMENTS`. Follow [guardrails](../syveka-context/references/guardrails.md).
**Do not modify code until the failure is classified with evidence.**

## Suite facts

- Config: `playwright.config.ts` — projects `auth-setup` → `desktop` + `mobile` (Pixel 7),
  locale `fi-FI`, `retries: 2` in CI, trace `retain-on-failure` (never on `auth-setup`).
- `E2E_BASE_URL` must be a bare origin (no path/credentials); required in CI.
- Deployment Protection: requests need `VERCEL_AUTOMATION_BYPASS_SECRET` header, else 401/redirect
  to Vercel login.
- Specs: `smoke.spec.ts` (public + authenticated gate), `business-dna.spec.ts`,
  `auth-journeys.spec.ts` (opt-in `E2E_AUTH_JOURNEYS=1`, desktop only, **mutates shared account
  password**), `creator-studio-live.spec.ts` (opt-in `CREATOR_STUDIO_LIVE_E2E=1`, **real paid
  providers, may publish**). Never enable opt-ins without explicit approval.
- Fixtures: `scripts/ensure-e2e-org-fixture.ts`, `ensure-e2e-auth-journey-fixtures.ts` **write**
  data — human gate outside local.
- Runs: CI via `staging-release.yml` (post-deploy smoke) and `pr-preview-e2e.yml` (dispatch).

## Classification

| Class                    | Evidence that proves it                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| APPLICATION BUG          | reproduces manually on the same build; server error/500 in logs; assertion reflects real wrong behavior              |
| TEST BUG                 | app behavior correct per spec/UI; selector/locale/timing assumption wrong; fails deterministically since a test edit |
| ENVIRONMENT PROBLEM      | `/api/health` degraded; fixture org/user missing; Deployment Protection 401; DB pool exhaustion                      |
| NETWORK/PROVIDER FAILURE | upstream 5xx/timeout (Anthropic, fal, Vapi, Resend, Supabase Auth); passes on retry with no code change              |
| CONFIGURATION DRIFT      | served `.build` SHA ≠ expected; env var missing/renamed in one env; alias points at old deployment                   |
| FLAKY TEST               | passes and fails on the **same SHA and env**; race in test (no await, fixed sleep, shared state across projects)     |

"Flaky" requires same-SHA evidence of both outcomes — never a default label.

## Workflow

1. Identify run, SHA, base URL, project (desktop/mobile), spec, and step. Confirm served SHA:
   `curl -s <base>/api/health` → `.build`.
2. Read the error, trace/screenshot (if retained), and the spec lines. Parallelize independent
   reads.
3. Classify with the table; mark VERIFIED/INFERRED.
4. Propose the smallest fix for that class only:
   - APPLICATION BUG → code fix + unit test, CLAUDE.md §2 workflow.
   - TEST BUG → fix the assertion/selector; never weaken what it proves or add `.skip`.
   - ENVIRONMENT / DRIFT → report + HUMAN GATE; hand off to `syveka-staging-audit`.
   - PROVIDER → report the upstream error; no code change unless handling is wrong.
   - FLAKY → fix the race (await/web-first assertion); never raise retries/timeouts to hide it.

Local run (only when safe): `npx playwright test tests/e2e/smoke.spec.ts --project=desktop`
against `localhost`. Do not point local runs at production.
