# Chrome DevTools MCP — Evaluation (not installed)

Companion to `docs/skills/scrapling-integration.md` and `docs/skills/SECURITY_REVIEW.md` — same
evaluation format, same conclusion pattern: this is a design/evaluation document, nothing here is
wired into Syveka.

## What it would add beyond Playwright

Playwright (already in use, `playwright.config.ts` + `tests/e2e/`) **drives and asserts** the UI —
navigate, click, fill, expect. It does not introspect the browser's own runtime/network state as a
first-class output. Chrome DevTools MCP (the official `chrome-devtools-mcp` server, Node/stdio
transport, published by the Chrome DevTools team) exposes the CDP protocol as MCP tools:

- Console messages (errors/warnings emitted during a session)
- Failed/slow network requests, response codes, timing
- DOM snapshot/inspection independent of a Playwright locator
- Performance traces (Core Web Vitals-adjacent metrics)
- Runtime error capture at the point of throw, not just "the page eventually errored"

This is genuinely complementary, not a duplicate: a Playwright test can assert "the page shows the
error card" (behavior); Chrome DevTools MCP would show _why_ — the actual console error and network
trace — the same category of evidence this session's own Business DNA crash investigation was
missing and could not obtain any other way (see `fix/business-dna-onboarding-crash`'s final report
in that branch's PR — the single blocker there was exactly "no way to capture the real browser
console error").

## Security posture

Unreviewed in this pass at the depth Scrapling received (no live Docker/network test performed —
see `docs/skills/scrapling-integration.md` for what that bar looks like). At a glance:

- Runs as a local Node process launching/attaching to a real Chrome instance — filesystem access
  to write traces/screenshots, and whatever network access the target page itself makes.
- No built-in allowlist/SSRF policy of its own (it drives a browser to whatever URL it's told,
  same category of risk as Playwright itself already has and already governs via
  `playwright.config.ts`'s `baseURL` + the standing rule "no automated browser tools get
  unrestricted production actions").
- Its risk profile is closer to "another way to drive/inspect a browser" than "a new class of
  network-egress risk" — Syveka already runs Playwright against staging with the same blast radius
  (arbitrary page navigation, arbitrary DOM access) under existing operational discipline (never
  run interactively against production, VERCEL_AUTOMATION_BYPASS_SECRET-gated in CI).

## Recommendation

**REVIEW / REFERENCE** (registered in `syveka-skills/core/registry/data.ts` as
`chrome-devtools-mcp`, capability `browser.debug`, not routable until reviewed). Recommended
integration path if/when adopted: **local, interactive, human-supervised use only** (a developer or
AI coding agent debugging a specific reported issue against staging), governed by the same
per-session judgment already applied to any interactive Playwright run — not a standing CI
dependency, and never pointed at production. Do not install until a specific debugging need (like
the Business DNA crash) makes the cost of a full security review worth paying — this document
records the shape of that review, not a green light to skip it.

## Why not build it into Playwright instead

Playwright itself exposes `page.on("console", ...)` and `page.on("requestfailed", ...)` listeners
— for a **known, reproducible** test scenario, extending an existing `tests/e2e/*.spec.ts` file
with these listeners (zero new dependencies, zero new MCP surface) is the smaller, safer fix and
should be preferred whenever the failure is already reproducible in a Playwright test. Chrome
DevTools MCP earns its place specifically for **interactive, exploratory** debugging of a
not-yet-reproduced issue — a different job than automated regression coverage.
