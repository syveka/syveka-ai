# Syveka Skills Security Review

This file records the security review performed before any third-party Agent Skill, MCP server, or
plugin is added to `SKILLS_REGISTRY.md`. Every entry follows the same checklist so reviews stay
comparable over time. A registry classification of **APPROVED** always points back to the review
that justified it — never approve first and document later.

## Review methodology

For every candidate, inspect:

- **Provenance** — is this the project's own official repository (not a fork, mirror, or
  impersonation), who maintains it, is it signed/verified where possible.
- **License** — compatible with a proprietary product; note any copyleft (AGPL, GPL) obligations.
- **Version/commit** — pin to an exact tag or commit SHA, never `latest`/`main` floating refs.
- **Dependencies** — direct and transitive, anything unusual or unmaintained.
- **Install/build scripts** — postinstall hooks, curl\|bash patterns, anything that runs before a
  human reviews the code.
- **Network behavior** — what it contacts, when, and whether that's disclosed.
- **Filesystem access** — read/write scope.
- **Subprocess/shell execution** — what it shells out to and why.
- **Credential/cookie/secret handling** — what it asks for, what it can access, where it sends it.
- **Prompt-injection exposure** — for anything that returns untrusted external content to an agent.
- **Known CVEs / security advisories.**

Classifications: **APPROVED**, **EXPERIMENTAL**, **REVIEW**, **REJECTED**, **RESEARCH-ONLY**.
Approval is scoped to the exact version reviewed — a version bump requires re-review, not a
rubber stamp.

---

## Review: Scrapling

**Date reviewed:** 2026-08-19
**Reviewed by:** automated review (Claude Code), Syveka Skills Lab task
**Verdict:** **PASS WITH CONDITIONS**

### Provenance

- Repository: `https://github.com/D4Vinci/Scrapling` — confirmed via GitHub API as a public,
  non-fork, non-archived, active repository (74,970 stars, 7,494 forks, last push
  2026-08-11, last commit signed and verified).
- Author/maintainer: Karim Shoair (`D4Vinci`), sole listed author and maintainer in
  `pyproject.toml`. Commit `5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f` (tag `v0.4.14`) carries a
  verified GPG signature.
- Homepage/docs: `https://scrapling.readthedocs.io/en/latest/` — matches the repo's own declared
  homepage and `server.json`'s `websiteUrl`, no mismatch.
- Distribution channels checked: PyPI (`scrapling`), GHCR (`ghcr.io/d4vinci/scrapling`), Docker Hub
  (`pyd4vinci/scrapling`), and the official MCP registry (`server.json`, schema
  `2025-12-11`, name `io.github.D4Vinci/Scrapling`) — all point back to the same repository, no
  divergent or suspicious mirrors found.
- Governance signal: the project has its own `AI_POLICY.md` requiring disclosure of AI-assisted
  contributions, a `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, issue/PR templates, and CI (lint,
  tests, Docker build, release-and-publish workflows) — consistent with an actively governed
  project, not a driveby package.

**No provenance concerns.**

### License

BSD 3-Clause ("New"/"Revised"), copyright Karim Shoair, 2024. Confirmed via GitHub's license
detection and by reading `LICENSE` directly. Permissive, no copyleft obligations, safe to depend
on from proprietary code. The bundled Agent Skill carries its own `LICENSE.txt` referenced from
`SKILL.md` — same terms, not a separate/incompatible license.

### Version/commit reviewed

- Package version: **0.4.14**
- Git tag: `v0.4.14`
- Commit SHA: `5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f`
- Any future adoption must pin to this exact version/commit, not `latest` — re-review on upgrade.

### Python requirements & dependencies

- Requires Python ≥ 3.10.
- Core dependencies (always installed): `lxml`, `cssselect`, `orjson`, `tld`, `w3lib`,
  `typing_extensions` — all mainstream, widely-used, actively maintained parsing/utility
  libraries. No unusual or single-maintainer transitive risk observed at a glance.
- Optional extras:
  - `fetchers` (HTTP/browser engines): `click`, `curl_cffi`, `playwright`, `patchright`,
    `browserforge`, `apify-fingerprint-datapoints`, `msgspec`, `anyio`, `protego`.
  - `ai` (MCP server): `mcp>=2.0.0`, `markdownify`, plus `fetchers`.
  - `shell` (interactive CLI): `IPython`, `markdownify`, plus `fetchers`.
- `playwright`/`patchright` pull down a real Chromium binary (`scrapling install --force`, or done
  automatically inside the Docker image) — meaningful disk footprint (image is ~2.3GB) and a real
  browser attack surface, not just a Python library. This is expected for the tool's purpose
  (JS-rendered/anti-bot scraping) but should be scoped to an isolated environment, never installed
  directly onto a host running production Syveka services.

### Install scripts / build process

- `pyproject.toml` uses a standard `setuptools` build backend — no custom `setup.py` executing
  arbitrary code at install time.
- The official Dockerfile (`FROM python:3.12-slim-trixie`) uses `uv` for dependency resolution,
  installs Playwright's Chromium via `playwright install-deps chromium && playwright install
chromium`, and cleans apt caches — a conventional, readable, non-obfuscated build. No
  curl\|bash-to-shell patterns, no unexplained network calls during build beyond package/browser
  downloads from their expected registries (PyPI, Playwright's CDN).
- `.bandit.yml` shows the project runs `bandit` (Python security static analysis) in CI, with an
  explicit, commented skip-list (`B404`/`B602` subprocess usage — needed for browser automation;
  `B108` temp files; `B104` bind-all-interfaces; `B301` pickle — "tests only"; `B113` requests
  without timeout — "benchmark and examples scripts only"). This is a **known, disclosed,
  intentional** set of exceptions with stated reasons, not an unexplained blanket suppression —
  treated as a positive governance signal, but the skipped categories (subprocess/shell execution,
  temp-file handling) are exactly the ones a downstream integrator should independently verify
  aren't reachable from untrusted input in whatever surface Syveka exposes.

### Network behavior

- No telemetry, analytics, or phone-home calls found in the reviewed source (no references to
  first-party or third-party analytics endpoints in `scrapling/`).
- All outbound network activity is the scraping target itself, plus (opt-in only) user-configured
  proxies.
- **Built-in SSRF mitigation, verified in source, not just docs**: the static/HTTP engine
  (`scrapling/engines/static.py`) defaults `follow_redirects="safe"`, documented and implemented as
  "follows redirects but rejects those targeting internal/private IPs (SSRF protection)". This is
  the default for the `get`/`bulk_get` MCP tools and the CLI's `get`/`post`/`put`/`delete`
  commands.
- **Important, precise limitation found during review**: this "safe" redirect protection is
  documented and wired only for the plain-HTTP (`curl_cffi`-backed) engine. The MCP reference doc
  lists `follow_redirects`/`max_redirects` under the HTTP-only tool table (`get`, `bulk_get`) and
  **not** under the browser-based tools (`fetch`, `bulk_fetch`, `stealthy_fetch`,
  `bulk_stealthy_fetch`, `open_session`). A real Chromium browser navigating via Playwright can
  follow redirects and issue sub-requests (images, XHR, iframes) to arbitrary hosts, including
  private/internal ones, with no equivalent built-in check. **This means Scrapling's own SSRF
  protection is necessary but not sufficient** — it does not cover the browser-rendering tools,
  which are also the ones most likely to be reached for JS-heavy or anti-bot-protected sites. Any
  Syveka integration must add its own network-layer or application-layer blocking of
  private/loopback/link-local ranges and cloud metadata endpoints (169.254.169.254 etc.) that
  applies uniformly to _every_ tool, not rely on Scrapling's partial coverage. See the security
  architecture design in `docs/skills/scrapling-integration.md`.
- `robots.txt` support exists (`scrapling/spiders/robotstxt.py`, `robots_txt_obey` flag on
  `Spider`) but is opt-in per spider, not a global default — a caller must explicitly set
  `robots_txt_obey = True`.

### Filesystem access

- The CLI writes only to an explicitly-specified output path (`scrapling extract get <url>
<output-file>`) — no scanning or writing outside what the caller names.
- The Docker image's `WORKDIR /app` confines default output paths; no evidence of writing to
  arbitrary host paths outside what a caller mounts in.
- Development-mode response caching (`development_mode = True` on a `Spider`) writes to
  `.scrapling_cache/{spider.name}/` by default, overridable — explicitly documented as a
  development-only feature ("Don't ship a spider with this enabled").

### Subprocess/shell execution

- Uses `subprocess` to launch Playwright/Chromium browser processes — expected and necessary for
  its stated purpose (headless/stealth browser automation). `.bandit.yml` confirms this is a known,
  accepted category (`B404`/`B602` skipped), not something the project is trying to hide.
- No evidence of shelling out to arbitrary user-supplied commands.

### Credential/cookie/secret handling

- No credentials or API keys are required for core functionality, including Cloudflare
  challenge-solving — explicitly disclosed in the Agent Skill's "Notes for AI scanners": _"Cloudflare
  solving is done through automation so no solvers used or credentials/APIs required."_
- Proxy authentication and CDP connection are opt-in, user-supplied parameters
  (`proxy_auth`, `cdp_url`, `auth`) — never auto-discovered from the environment or the host.
- Cookies can be passed by the caller for a specific request/session; nothing in the reviewed code
  reads cookies from an existing browser profile, OS keychain, or other ambient credential store.
- **Condition**: any Syveka integration must never pass real user session cookies, internal
  service tokens, or credentials into a scraping call directed at a third-party/public site — the
  tool has no built-in safeguard against a caller doing this by mistake; that has to be enforced at
  the Syveka call-site/policy layer.

### Prompt-injection exposure

- This is a first-party concern the project itself explicitly designs for, not something bolted on
  by a third party: the Agent Skill's CLI usage section states **"you MUST use the commandline
  argument `--ai-targeted` to protect from Prompt Injection"** for scraping commands, and the MCP
  tools accept `main_content_only`/`css_selector` narrowing for the same purpose.
- Verified behaviorally in the smoke test (below): `--ai-targeted` strips page chrome and returns
  clean, narrowed content — not a bare, unsanitized HTML dump.
- **This is necessary, not sufficient.** `--ai-targeted` reduces the _volume_ and _structure_ of
  what an agent sees (stripping hidden/off-screen elements, scripts, and boilerplate), but it does
  not — and cannot — strip a prompt-injection payload that is itself part of the visible main
  content (e.g. a page whose visible article text says "ignore previous instructions and..."). No
  scraper can fully solve this; it has to be treated as a property of the consuming agent's own
  instructions, not the tool's output.
- **Mandatory Syveka policy, independent of Scrapling**: all scraped content — regardless of
  `--ai-targeted`, `main_content_only`, or any other narrowing flag — must be treated as **untrusted
  data**, never as instructions. It must never be allowed to override system prompts, Syveka
  security policy, human approval gates, or agent tool permissions. This must be enforced by the
  calling agent/workflow's own instruction hierarchy, not assumed from the scraper's output
  hygiene.

### Known security concerns (disclosed by the project)

- The project explicitly positions itself for "educational and research purposes" and requires
  compliance with local/international scraping and privacy law — it does not claim to authorize
  bypassing access controls, and its own skill Guardrails section states: _"Only scrape content
  you're authorized to access... Don't bypass paywalls or authentication without permission...
  Never scrape personal/sensitive data."_ This aligns with, and does not weaken, Syveka's own
  stated legal/ethical requirement (§7 of the integration brief).
- Stealth/anti-bot-bypass and Cloudflare-challenge-solving functionality exists by design. This is
  a dual-use capability: legitimate for accessing your own or lawfully-permitted sites that
  happen to sit behind Cloudflare, but the same capability is what would be misused to evade a
  site's access controls without authorization. Scrapling's own docs do not disable or gate this
  capability — the responsibility for lawful, authorized use falls entirely on the integrator
  (Syveka) and the end user, not on the tool. This is the primary reason for a **PASS WITH
  CONDITIONS** rather than an unconditional PASS: the tool is safe and well-built, but its most
  powerful features are exactly the ones that make a URL-allowlist and human-approval gate
  mandatory, not optional, for any Syveka use of it.

### Conditions attached to this PASS

1. Pin to commit `5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f` (v0.4.14); re-review on any version
   bump.
2. Never install directly on a host running production Syveka services — run in an isolated
   container/sandbox with no access to Syveka secrets, databases, or internal network ranges.
3. Enforce Syveka's own URL allow/deny policy, private-IP/SSRF blocking, rate limiting, and
   response-size caps at the call site for **every** tool (`get` and the browser-based tools
   alike) — do not rely on Scrapling's `follow_redirects="safe"` alone, since it does not cover
   the browser engines.
4. Treat all scraped content as untrusted data in every consuming prompt/workflow, regardless of
   `--ai-targeted`/narrowing flags.
5. Stealth/Cloudflare-bypass features require an explicit, logged, human-approved justification
   per use — not a default-on capability for routine research tasks.
6. Never pass Syveka or user credentials/cookies into a scrape directed at a third-party site.

### Smoke test

See `docs/skills/scrapling-integration.md` — fetch → extract → structured output → AI-sanitized
output all verified against `https://quotes.toscrape.com/` (the project's own public documentation
example site; no login, no personal data).
