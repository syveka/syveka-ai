# Browser QA — What Exists, What This Pass Adds

## Existing: `playwright.config.ts` + `tests/e2e/smoke.spec.ts`

Reused as-is, not rebuilt. `desktop`/`mobile` projects, staging-aware (`E2E_BASE_URL`,
`VERCEL_AUTOMATION_BYPASS_SECRET`), Finnish locale by default. Covers: login UI, FI landing,
locale/RTL switch, unauthenticated redirect, health + auth-enforcement API checks, dashboard KPIs,
chat streaming, CRM contact create, deals kanban, companies/calendar/knowledge navigation.

## Added this pass: `tests/e2e/helpers/auth.ts` + `tests/e2e/business-dna.spec.ts`

- `helpers/auth.ts` extracts the login flow into `loginAsE2EUser(page)` /
  `requireE2EUserCredentials()` — new specs use this instead of a third copy-paste of the login
  steps. `smoke.spec.ts` was **not** refactored to use it; it already works and rewriting a stable,
  passing test file to fit a new helper is exactly the risk this foundation pass is told to avoid.
- `business-dna.spec.ts` — the flow that had a real staging crash report
  (`fix/business-dna-onboarding-crash`) and zero e2e coverage before this pass:
  1. Page loads with no `pageerror` event (the exact signal a real client-side exception fires —
     this is the automated equivalent of the "Application error: a client-side exception has
     occurred" screen the crash report described).
  2. Editing and saving a field round-trips through the real Server Action and shows the real
     "Tallennettu." confirmation.
  3. The `RegenerateFromWebsite` client component (one of the components individually cleared by
     render-testing on the crash-fix branch) actually mounts on the live route.

This does not close the crash-fix branch's own open blocker (the exact throw still was not
reproduced there) — it adds standing regression coverage so that _if_ the same class of failure
recurs, CI catches it on this branch's own future PRs, independent of whether Ehab's manual
reproduction on `fix/business-dna-onboarding-crash` ever succeeds.

## Chrome DevTools MCP

Evaluated, not installed — see `docs/skills/chrome-devtools-mcp-evaluation.md`. Recommended as a
human-supervised, interactive debugging aid for issues Playwright's own console/network listeners
can't yet reproduce automatically, not a CI dependency.

## Explicit non-goals for this pass

No new Playwright config, no visual-regression/screenshot-diffing tool, no CI workflow changes.
`business-dna.spec.ts` runs under the existing `npm run test:e2e` command and existing
`staging-release.yml`/`ci.yml` invocation — nothing new to wire up.
