# Syveka Master Skill — MVP Scope

> **Update (Milestone 2):** web research (`web.research`, was `research.web.fetch`/
> `research.web.extract` in this original document) moved from stub to a real, live-tested
> Scrapling provider. The rest of this document describes the original MVP baseline and is
> otherwise still accurate - see `docs/skills/scrapling-integration.md`'s "Milestone 2" section
> and `docs/provider-model.md` for what changed.

## What this MVP proves

That the core governance loop (intent -> plan -> route -> permission -> execute -> evidence ->
verify -> report) is a real, working, testable architecture - not that Syveka has integrated
every third-party Skill reviewed so far. Per the product brief: "Implement only enough
capabilities to prove the architecture."

## MVP capabilities implemented

1. **Software engineering** (`engineering.test`, `engineering.diff_capture`) - real, via
   `local-test-runner` and `git-diff` providers.
2. **UI work** (`ui.component.search`, `ui.taste.evaluate`) - routing implemented, providers are
   honest stubs (`shadcn-mcp`, `twentyfirst-dev` not connected).
3. **Skill discovery** (`skill.discovery`) - real, via `skill-registry-lookup` against the actual
   registry.
4. **Evidence-first verification** - real, `core/evidence` + `core/verification`, exercised by
   every demo and by `evals/anti-sycophancy.test.ts`.

Video (`video.analyze`) and web research (`research.web.fetch`/`research.web.extract`) are wired
as routable capabilities with honest stub providers, per the brief's explicit allowance: "Video and
web research can initially be provider adapters or optional capabilities."

## The 3 required demos

### Demo 1 — UI ("Improve this dashboard")

**Result: CAPABILITY_UNAVAILABLE**, not a fabricated UI improvement. Neither shadcn/ui MCP nor
21st.dev has a live connection in this environment (both are registry status `REVIEW`, not
`APPROVED`). This demo exists specifically to prove the failure-handling requirement: _"If a
provider is unavailable: report capability unavailable instead of pretending success."_
Run: `npm run demo:ui-improvement`.

### Demo 2 — Bug fix ("Fix this failing workflow")

**Result: COMPLETE, VERIFIED.** Fully real: a genuine failing Node test (RED, confirmed by
actually running it), a real code fix applied to a throwaway git repo, the orchestrator re-running
the real test (GREEN) and capturing a real `git diff`, real evidence, real verification. The one
scripted part is the fix itself - writing correct code is the host LLM agent's job, not this
orchestrator's (see `docs/product-vision.md` "Where the LLM fits"). Everything downstream of the
fix (test execution, diff capture, evidence collection, verification, reporting) is the
orchestrator doing real work against real command output, not simulated. Run: `npm run
demo:bug-fix`.

### Demo 3 — Skill discovery ("Find a skill for PDF analysis")

**Result: COMPLETE, VERIFIED - zero matches found.** Real registry search (keyword-matched
against `name`/`capability`/`id`). Nothing in the current registry serves PDF analysis, so the
demo reports that honestly rather than fabricating a plausible-sounding recommendation -
demonstrating "discovery never equals trust" and "never auto-install" without pretending to
discover something that doesn't exist. Run: `npm run demo:skill-discovery`.

## Why 2 of 3 demos show an "unavailable"/"no match" result

This is not a shortfall - it's the most credible evidence this MVP could produce for its own
central claim. Faking all three demos as clean successes would have been easy and would have
proven nothing about whether the evidence-first, never-fabricate-success architecture actually
works under real constraints (no live shadcn/21st.dev connection, an empty-of-PDF-tools registry).
Showing it degrade honestly under those exact real constraints is stronger proof than three
scripted happy paths would have been.

## Explicit non-goals of this MVP (do not read as "already built")

- No live approval transport (Slack/email/UI) - `ApprovalGate` is in-memory only.
- No live connections to shadcn MCP, 21st.dev, Scrapling, or claude-video - all four are honest
  stubs.
- No live Codex or Gemini CLI testing - both adapters are format-only, unverified translations of
  the same registry data the Claude Code adapter renders.
- No skill security scanning _automation_ - `docs/skills/SECURITY_REVIEW.md`'s methodology is
  documented and was applied by hand to Scrapling; it is not yet a callable capability in this
  codebase (no `skill.security_review` provider exists).
- No database-backed registry - `core/registry/data.ts` is a static, in-memory array.
- No billing/plan enforcement - `docs/commercialization.md` is opportunity documentation only.
- No sandboxing beyond individual providers' own safe command execution (see
  `docs/security-model.md` "Explicit non-goals").

## Recommended next milestone

Wire one real external provider end-to-end (Scrapling is the best candidate - it already has a
passed security review) behind its own isolated container, per the design already written in
`docs/skills/scrapling-integration.md`, and add the eval coverage that provider needs (a real
"provider goes from available to unavailable mid-task" test, not just a stub). That would prove
the architecture against a genuine external dependency, not just first-party local providers.
