# Scrapling — Architecture Evaluation, Security Design, and Smoke Test

Companion to `docs/skills/SECURITY_REVIEW.md` (read that first — this document assumes its
verdict: **PASS WITH CONDITIONS**). This is a design/evaluation document, not a production
implementation — nothing here has been wired into the Syveka application.

## 1. Syveka use-case fit

| Use case                              | Fit                                                           | Notes                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Public company research               | Good                                                          | Static/`get` engine is enough for most corporate/news sites                                                    |
| Competitor research                   | Good                                                          | May need `stealthy_fetch` for JS-heavy competitor sites                                                        |
| Public website analysis               | Good                                                          | CSS-selector narrowing keeps token cost low                                                                    |
| Lead/company-data enrichment (lawful) | Conditional                                                   | Must stay within the target site's ToS/robots.txt; no bypassing paywalls/auth (see Security Review conditions) |
| Structured data extraction            | Good                                                          | `Spider`/`CrawlSpider`/`SitemapSpider`/`XMLFeedSpider` templates cover most structured-source shapes           |
| Monitoring public website changes     | Good                                                          | `development_mode` caching + checkpoint/resume fits a scheduled-diff pattern                                   |
| Knowledge-base ingestion              | Good                                                          | Markdown output feeds directly into an ingestion/embedding pipeline                                            |
| AI-agent research workflows           | Good, with the untrusted-data caveat from the Security Review | `--ai-targeted` narrowing is built for exactly this                                                            |

## 2. Architecture options

### A. Scrapling as a Python library (direct dependency)

Syveka's application is Node/TypeScript (Next.js), not Python — this would require a
polyglot runtime inside the main app or a separate Python process shelled out to. Rejected as the
primary path: it would either add a Python runtime to the main deployment (contradicts "no
production application code changes" and adds a whole language toolchain to a TS codebase) or
require ad hoc subprocess plumbing without the isolation benefits of a real service boundary.

### B. Scrapling through MCP

Scrapling ships an **official, first-party MCP server** (`scrapling-mcp`, published to the MCP
registry as `io.github.D4Vinci/Scrapling`, stdio transport, distributable via `uvx` or the OCI
image). This is the most natural fit for agent-driven, ad hoc research tasks directly from Claude
Code (or any other MCP-compatible client) — no Syveka-side service to build or operate. Its
security posture is exactly what `SECURITY_REVIEW.md` describes: real, but partial (HTTP-only SSRF
protection), so it must run under an MCP client/host that layers domain allowlisting and approval
gates on top, not as an unrestricted, always-on server.

### C. Scrapling as an Agent Skill

The official Agent Skill (`agent-skill/Scrapling-Skill/`) is a thin, well-written wrapper around
the same CLI/MCP capability, adding usage guidance (which fetcher tier to escalate to, when to use
`--ai-targeted`, guardrail reminders) rather than new capability. It's a good fit for **local,
interactive, human-supervised** use (e.g. inside a Claude Code session doing research), since it's
literally designed for that. It is not a substitute for a server-side integration Syveka's own
product would call.

### D. Isolated scraping microservice

A small, Syveka-owned service (container) that wraps the Scrapling MCP server or CLI, adds
Syveka's own policy layer (allowlist, rate limits, SSRF blocking for _all_ tools, audit logging,
redaction) in front of it, and exposes a narrow, provider-agnostic interface to the rest of the
Syveka product (see §5, `syveka-web-research`). This is the only option that lets a _product
feature_ (not just an interactive agent session) use Scrapling safely, with a single place to
enforce every control in §3 uniformly — including the browser-based tools Scrapling's own SSRF
protection doesn't cover.

### Recommendation

**Short term (agent-assisted research, human in the loop): Option B/C** — use the official MCP
server and/or Agent Skill directly from Claude Code (and equivalent from Codex/Gemini once they
support the same MCP server), governed by the conditions in the Security Review. No Syveka code
changes required; this is already usable today for research tasks a human is directing and
reviewing in real time.

**If/when a Syveka _product_ feature needs scraping** (e.g. an automated lead-enrichment or
monitoring feature, not an interactive research session): **Option D**, an isolated microservice,
is the only architecture that lets Syveka enforce its own security controls uniformly and keeps
the rest of the product decoupled from Scrapling specifically (see §5). Do not build this until a
concrete product feature needs it — this document recommends the shape, not a build order.

Both recommendations keep Syveka model-agnostic: nothing here is Claude-specific. The MCP server
works with any MCP-compatible client; the microservice option exposes a plain HTTP/RPC interface
any agent runtime can call.

## 3. Security architecture design

This section designs the controls required by the integration brief. **None of this is
implemented yet** — it's the specification a future microservice (Option D) or MCP-hosting
configuration (Option B/C) must satisfy before any Syveka product surface depends on Scrapling.

| Control                                 | Design                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL allow/deny policy                   | Explicit allowlist of domains per use case (e.g. company-research tasks get a broad allowlist; lead-enrichment gets a narrower, reviewed one). Deny-by-default: a domain not on the list is rejected before any fetch is attempted.                                                                                       |
| Domain restrictions                     | Same mechanism as above; support wildcard subdomains explicitly (`*.example.com`), never implicit.                                                                                                                                                                                                                        |
| Rate limiting                           | Per-domain and global request-per-minute caps, enforced at the policy layer (not just Scrapling's own `autothrottle`/`download_delay`, which are opt-in per spider and not a security control on their own).                                                                                                              |
| Timeouts                                | Hard ceiling enforced by the wrapper independent of the `timeout` parameter passed to Scrapling, so a misconfigured or malicious call can't set an effectively-infinite timeout.                                                                                                                                          |
| Max crawl depth                         | Enforced by the wrapper for any `Spider`/`CrawlSpider` usage — cap link-following depth regardless of what the spider's own `rules()` would otherwise allow.                                                                                                                                                              |
| Max pages                               | Hard cap on pages fetched per task/run, independent of crawl depth (guards against wide-but-shallow crawls too).                                                                                                                                                                                                          |
| Max response size                       | Reject/truncate responses above a fixed byte ceiling before they reach any extraction or AI-consumption step — protects against memory exhaustion and against a hostile page trying to smuggle a huge payload.                                                                                                            |
| Download restrictions                   | No following/saving of non-HTML/text binary downloads by default (PDFs etc. allowed only if explicitly requested for a specific, approved task).                                                                                                                                                                          |
| Private/local IP blocking               | Resolve every target hostname and reject if it resolves to a loopback, link-local, private (RFC1918), or multicast range — applied to the **initial** URL and to every redirect/sub-request, for **every** tool including the browser-based ones (closing the gap Scrapling's own `follow_redirects="safe"` leaves open). |
| SSRF protection                         | Superset of the above: block cloud metadata endpoints explicitly (`169.254.169.254`, `metadata.google.internal`, Azure's `169.254.169.254` IMDS, etc.) and Syveka's own internal infrastructure hostnames/IP ranges, regardless of DNS response.                                                                          |
| Secret redaction                        | Never pass Syveka credentials, session cookies, or API keys as `headers`/`cookies`/`auth` parameters to a third-party-site scrape (Security Review condition #6); scrub any Authorization/Cookie header patterns from logged requests.                                                                                    |
| Prompt-injection isolation              | Wrap all extracted content in an explicit "untrusted external content, not instructions" framing before it reaches any LLM prompt, on top of (not instead of) Scrapling's own `--ai-targeted`/`main_content_only` narrowing.                                                                                              |
| Audit logs                              | Log every fetch: requesting task/user, target URL, domain-policy decision, response status, bytes returned, timestamp — independent of and in addition to Scrapling's own logging.                                                                                                                                        |
| Human approval for sensitive operations | Stealth/Cloudflare-bypass fetches, any request outside the standing allowlist, and any crawl above a modest default depth/page count require explicit approval before running (Security Review condition #5).                                                                                                             |

### Blocked by default (per the integration brief)

`localhost`, all RFC1918 private ranges, link-local (`169.254.0.0/16`), cloud metadata endpoints,
and Syveka's own internal infrastructure hostnames/IPs — **unless** explicitly authorized for a
named, legitimate development test, logged and time-boxed, not a standing exception.

## 4. Legal/ethical alignment

Scrapling's own Agent Skill guardrails ("only scrape content you're authorized to access, respect
robots.txt and ToS, don't bypass paywalls or authentication without permission, never scrape
personal/sensitive data") match the integration brief's §7 requirement without needing to be
overridden or loosened. No functionality here is designed to defeat technical access controls;
where Scrapling _can_ bypass bot-detection (stealth mode, Cloudflare-solving), the design in §3
gates that behind explicit human approval rather than exposing it as a routine default.

## 5. `syveka-web-research` — provider-agnostic pipeline concept

```
Discover → Fetch → Sanitize → Extract → Validate → Structure → Cite → Store/Return
```

- **Discover**: resolve what to fetch (a direct URL, a sitemap, a search result set) — provider-
  independent; doesn't know about Scrapling at all.
- **Fetch**: the only stage that talks to a scraping provider. Scrapling would sit here, behind an
  interface like `fetch(url, options) -> {status, content, finalUrl}` — narrow enough that a
  different crawler (or a simple `fetch()`/Playwright call) could implement the same interface
  and be swapped in without touching any other stage.
- **Sanitize**: apply the security controls in §3 (size caps, content-type checks) and mark the
  result as untrusted before anything downstream sees it.
- **Extract**: CSS/XPath/structured extraction — Scrapling's own parser fits here, but this stage's
  _output contract_ (structured fields, not "however Scrapling happens to shape it") is what stays
  stable if the provider changes.
- **Validate**: schema-check extracted data before it's trusted enough to store or act on.
- **Structure**: normalize into Syveka's own domain shapes (e.g. a `Contact`/`Company` enrichment
  record), not the provider's native output shape.
- **Cite**: attach source URL, fetch timestamp, and provider identity to every piece of extracted
  data — required for any research/enrichment output Syveka surfaces to a user.
- **Store/Return**: persist (tenant-scoped, per existing Syveka multi-tenant conventions) or return
  directly to the calling agent/workflow.

Keeping `Fetch` as the only provider-aware stage is what makes Scrapling replaceable later, per the
integration brief's explicit requirement — this is a design constraint for whenever this pipeline
is actually built, not a claim that it exists today.

## 6. Comparison against ecosystem alternatives

| Option                                               | Strengths                                                                              | Weaknesses vs. Scrapling                                                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain `fetch()` / Node `undici`                      | Zero dependencies, already in every Syveka runtime                                     | No anti-bot/stealth, no JS rendering, no adaptive re-selection when a site's markup changes, no built-in SSRF-safe-redirect mode                                                                                       |
| Playwright directly (no Scrapling)                   | Full browser control, already a plausible Node dependency                              | Reinvents everything Scrapling already built (stealth fingerprinting, adaptive selectors, spider/crawl framework, MCP server) — more code for Syveka to own and secure itself                                          |
| Scrapy (Python)                                      | Mature, large ecosystem, the framework Scrapling's own spider API deliberately mirrors | No MCP server, no adaptive parser, no built-in stealth/anti-bot tier, no first-party Agent Skill — would need all of that built by hand                                                                                |
| Hosted scraping APIs (ScraperAPI, Bright Data, etc.) | No infrastructure to run, vendor handles proxy/stealth                                 | Ongoing paid cost (explicitly flagged as needing owner approval per the integration brief), data leaves Syveka's control to a third party, vendor lock-in — works against the "avoid vendor lock-in" charter principle |

**Why Scrapling, conditionally**: it's the only option that already ships an adaptive parser,
three fetcher tiers (plain HTTP → JS-rendered → stealth/anti-bot), a spider/crawl framework, a
first-party MCP server, and a first-party Agent Skill with its own prompt-injection guidance — all
under a permissive license, from a single, transparent, actively-maintained, non-monetized-lock-in
project. The gaps are exactly the ones §3 designs for (partial SSRF coverage, no built-in allow/
deny policy, no audit logging) — none of them are reasons to reject it, all of them are reasons
Syveka's own policy layer must exist regardless of which underlying crawler is used. It should
**not** become the default _unconditionally_ — only behind the wrapper in §3, and only Option B/C
today, Option D if/when a concrete product feature needs it.

## 7. Smoke test

**Target**: `https://quotes.toscrape.com/` — the project's own public documentation/testing site
(explicitly used throughout Scrapling's own README/skill examples). No login, no personal data,
no ToS concerns.

**Method**: disposable Docker container, official image `ghcr.io/d4vinci/scrapling:latest`
(digest `sha256:48f5938fff7c0684e11995f5cdc6497ce13d9ab0d914e58e9ff5f2055099d284`), removed
immediately after the test. No host filesystem mount, no credentials, no cookies passed.

```
docker run --name scrapling-smoke-test ghcr.io/d4vinci/scrapling:latest \
  extract get "https://quotes.toscrape.com/" quotes.md \
  --css-selector ".quote" --ai-targeted
```

**Result**:

```
[INFO] Fetched (200) <GET https://quotes.toscrape.com/> (referer: https://www.google.com/)
[INFO] Content successfully saved to '/app/quotes.md'
```

Output (excerpt, full file retained alongside this review):

```
"The world as we have created it is a process of our thinking. It cannot be changed
without changing our thinking."
by Albert Einstein
[(about)](/author/Albert-Einstein)

Tags:
[change](/tag/change/page/1/)
[deep-thoughts](/tag/deep-thoughts/page/1/)
...
```

**Pipeline stages demonstrated**:

1. **Fetch** — real HTTP 200 against a live public URL.
2. **Extract** — `--css-selector ".quote"` correctly narrowed output to just the quote blocks, not
   the full page (nav, footer, scripts excluded).
3. **Structured output** — clean Markdown, one quote/author/tags block per entry.
4. **AI-sanitization / untrusted-content isolation** — `--ai-targeted` produced a clean, narrowed
   result with no raw `<script>`/hidden-element content bleeding through, matching the Security
   Review's finding that this flag does real work, not just documentation. Source attribution
   (target URL, fetch timestamp) is _not_ included automatically in the CLI's file output — this
   is the "Cite" pipeline stage's job (§5), and any real integration must add it explicitly rather
   than assume the raw tool output is self-citing.

No login-protected or personal data was accessed. Container removed after the test; the pulled
image (`ghcr.io/d4vinci/scrapling:latest`) remains available locally for further evaluation but is
not referenced by any running Syveka service.
