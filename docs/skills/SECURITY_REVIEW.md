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

---

## Review: Strix

**Date reviewed:** 2026-10-21
**Reviewed by:** automated review (Claude Code), Strix integration setup task
**Verdict:** **PASS WITH CONDITIONS** (classification **EXPERIMENTAL**; installation and
preparation only, no scan authorized)

Scope of this review: the five official Agent Skills installed into `.claude/skills/`, the
`strix-agent` CLI installed on the setup machine, the `strix-sandbox` Docker image, and the
`skills` npm CLI used to install the skills. The runbook is
`docs/strix-security-testing-runbook.md`.

### Provenance

- Repository: `https://github.com/usestrix/strix` — confirmed via the GitHub API as public,
  non-fork, non-archived, created 2025-08-05, default branch `main`, 70,764 stars, 7,847 forks,
  last push 2026-10-21, license `Apache-2.0`, homepage `https://strix.ai`.
- Skills were taken from `main` at `a3c31236bd6305784a501a3102dab0bda83f2317`
  (2026-10-21T15:30:08Z); that commit carries a valid GPG signature. Each installed `SKILL.md`
  matched the file at that commit byte for byte after LF normalization (the clone on Windows
  produced CRLF; the committed files are LF and Prettier-formatted).
- CLI: PyPI `strix-agent` 1.7.0 (uploaded 2026-10-05) corresponds to GitHub release `v1.7.0`,
  tag commit `55bc07991aacb1c26a81b43e7ca53148730d2019`. That tag commit is **unsigned**. The
  package's `pyproject.toml` names the same repository and the `strix` console entry point.
- Sandbox image `ghcr.io/usestrix/strix-sandbox:1.3.0` is published under the same GitHub
  organization and is the default of `STRIX_IMAGE` in `strix/config/settings.py` at v1.7.0.
- Documentation at `https://docs.strix.ai` and the README point back to the same repository; no
  divergent mirror found.
- Installer: npm `skills` 1.7.4 (`vercel-labs/skills`, MIT), maintainers `rauchg` and `quuu`,
  published from GitHub Actions through npm trusted publishing (OIDC). The published package was
  unpacked and read before use: dependencies `tar` and `yaml` only, no install-time script for
  consumers, network calls to `api.github.com`/`github.com`/`raw.githubusercontent.com` for the
  clone and to `skills.sh` for telemetry (disabled with `DO_NOT_TRACK=1`).

**No provenance concerns**, with the note that release tags are not signed.

### License

Apache-2.0 for the repository, the skills (`license: Apache-2.0` in every frontmatter) and the
PyPI package. Permissive; compatible with a proprietary product. The managed cloud
(app.strix.ai) is a separate commercial service and is not used.

### Version/commit reviewed

- Skills: `main` @ `a3c31236bd6305784a501a3102dab0bda83f2317`.
- CLI: `strix-agent==1.7.0` (`v1.7.0` @ `55bc07991aacb1c26a81b43e7ca53148730d2019`).
- Image: `ghcr.io/usestrix/strix-sandbox:1.3.0` (about 1.4 GB compressed, linux/amd64).
- Installer: `skills@1.7.4`.

Any newer version requires a re-review of this section and of the conditions below.

### Python requirements & dependencies

`requires-python >= 3.12`. Seventeen direct dependencies: `openai-agents[litellm]`, `openai`,
`litellm`, `google-auth`, `boto3`, `pydantic`, `pydantic-settings`, `rich`, `docker`,
`requests`, `cvss`, `caido-sdk-client`, `markdown-it-py`, `reportlab`, `pypdf`, `cryptography`,
`pyyaml`. `litellm` and `boto3`/`google-auth` are there for multi-provider model access; `docker`
drives the sandbox; `caido-sdk-client` is the HTTP-proxy integration; `reportlab`/`pypdf` produce
reports. The transitive set is large (the uv install resolved well over one hundred packages),
which is why the CLI lives in its own uv tool environment and nowhere near the application's
`package-lock.json`. The skills have no dependencies.

### Install scripts / build process

- The documented `curl -sSL https://strix.ai/install | bash` was downloaded to a scratch
  directory and read in full, not executed. It downloads a prebuilt binary for the platform from
  GitHub Releases into `~/.strix/bin`, deletes any other `strix` found on `PATH`, appends an
  `export PATH=...` line to the shell rc file, and pulls the sandbox image. None of that was
  wanted; the project also documents package-manager installs (`pipx`, `uv`, `pip`).
- Installed with `uv tool install --python 3.12 "strix-agent==1.7.0"`: a plain wheel install
  into an isolated environment, no post-install hooks observed, no change to global Claude Code
  configuration or shell profiles.
- Skills installed with `npx skills@1.7.4 add usestrix/strix -a claude-code -s ... -y --copy`.
  The CLI clones the repository, copies the selected `SKILL.md` files into `.claude/skills/`
  and writes `skills-lock.json`. No symlinks, no `.agents/` directory left behind.

### Network behavior

When a scan runs, Strix contacts:

- The LLM provider selected by `STRIX_LLM` (via LiteLLM), with every file the agents read, every
  request/response exchanged with a target, the instruction text and the agents' reasoning.
- `ghcr.io` for the sandbox image (first run or `docker pull`).
- Telemetry: PostHog (`https://us.i.posthog.com`) and Scarf (`https://strix.gateway.scarf.sh`),
  per `strix/telemetry/{posthog,scarf}.py` and the project's telemetry README; disabled with
  `STRIX_TELEMETRY=0`. Optional remote OpenTelemetry export only if `TRACELOOP_*` is set.
- Optional web search (Perplexity/Exa) only if those keys are set.
- `app.strix.ai` only for `strix cloud ...` commands, which are not authorized for Syveka.
- The targets themselves, from inside the sandbox container. The sandbox reaches the host via
  `host.docker.internal`, so a local target is reachable; so is anything else the container's
  network can reach.

`strix --version` and `strix --help` were run with `STRIX_TELEMETRY=0`.

### Filesystem access

- A local directory passed with `-t` is mounted into the sandbox **writable** (stated in
  `--help` and in the skills). Agents can modify or delete files there. Runs must therefore use a
  clean, disposable checkout.
- `--workspace-file` copies a host file into the sandbox; the host copy is not changed.
- Output: `./strix_runs/<run>/` in the current directory (gitignored in this repository). State:
  `~/.strix/cli-config.json` and `~/.strix/mcp-servers.json` (neither was created by the
  verification commands).
- The skills write nothing.

### Subprocess/shell execution

The CLI talks to the Docker daemon through the Python SDK (create, exec, remove containers). The
agents execute arbitrary security tooling and shell commands inside the sandbox container, which
is the product's purpose. On the host the CLI itself runs no shell commands beyond Docker SDK
calls. The skills instruct Claude Code to run `strix ...`, `docker info`, and (in the install
step) the `curl | bash` line or `pipx install`; the latter two are superseded by this repository's
runbook and must not be executed by an agent here.

### Credential/cookie/secret handling

- `LLM_API_KEY` is read from the environment or `~/.strix/cli-config.json` (the docs show the
  key stored in that JSON in plaintext; prefer environment variables for the duration of a run).
  `OPENAI_API_KEY` is accepted as a fallback alias, so the application's OpenAI key must not be
  exported in the shell that runs Strix.
- Test credentials for a dynamic target are passed through `--instruction` /
  `--instruction-file`; they are sent to the model provider and should be throwaway values kept
  in a gitignored file (`security/strix/instruction.local.md`), not on the command line.
- Findings in `strix_runs/` include proofs of concept and data samples: sensitive, never
  committed, never pasted into public channels.
- No credentials are stored in the skills or in `skills-lock.json`.

### Prompt-injection exposure

High by design: the agents read untrusted content (target source, HTTP responses, documents) and
act on it with tools. A hostile target could steer an agent. Mitigations are structural: the agent
runs in a disposable container, the only writable host path is the mounted target directory, and
the operator chooses the targets. For Syveka this means only targets we control are ever in
scope, and a scan is never run from a working tree that matters. Agents also reach the LLM with
everything they read, so secret material must not be present in the target.

### Known security concerns

- No published GitHub security advisories for `usestrix/strix`; no OSV entries for PyPI
  `strix-agent` or npm `skills` as of 2026-10-21.
- Release tags are unsigned (commits on `main` are signed).
- Budget enforcement is a best-effort estimate inside the CLI (`--max-budget` is a hard stop in
  headless mode, but cost is computed from token usage and pricing, may overshoot slightly, and
  can under-count providers that return no priced usage). There is no provider-side cap; one must
  be configured at the provider.
- A clean exit (`0`) is not proof of coverage; a run that was stopped by budget or turns still
  exits `0`.

### Conditions attached to this PASS

1. Pin to the versions above; re-review on any change to the skills, the CLI or the image.
2. No scan of any kind without a written authorization naming commit, targets, budget, model and
   recipient of the findings (`docs/strix-security-testing-runbook.md` §6).
3. Targets come only from the explicit allowlist (`security/strix/targets.local.txt`). Production
   hosts, the production Supabase project, real customer or pilot data, production credentials and
   all third-party services are permanently excluded. Staging is excluded until the runbook's
   §4.3 checklist is complete for it.
4. Dynamic targets run with mocked or test-mode integrations (runbook §4.2) so that no e-mail,
   call, charge or customer workflow can be triggered.
5. `--max-budget` on every run, a dedicated LLM key with a provider-side spend cap, never the
   application's keys; `STRIX_TELEMETRY=0`.
6. Code targets are clean, disposable checkouts, never a working tree with uncommitted work.
7. Findings stay private and are validated by a human before being treated as real; fixes follow
   `CLAUDE.md` §2 and are retested.
8. No `strix cloud` usage, no automatic scanning in CI; a manual workflow may be added only under
   its own authorization (runbook §8).
9. An agent following the installed skills must not run the upstream install commands they
   contain; installation is governed by the runbook.

### Smoke test

Deliberately limited to non-scanning checks: `strix --version` (`strix 1.7.0`), `strix --help`
(flag set matches the CLI reference), a Docker SDK `ping()` from the tool environment (engine
29.7.2, linux/amd64), and the sandbox image pull. No scan was started, no model call was made,
no account was created.
