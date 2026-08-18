# Syveka Skills Registry

Tracks every third-party Agent Skill, MCP server, or plugin evaluated for use with Syveka Skills
Lab. Nothing here is trusted merely by being listed — every entry's classification points to the
review that justified it (`docs/skills/SECURITY_REVIEW.md`), and every _use_ of an APPROVED entry
still operates under whatever permission boundaries the calling context enforces (see each entry's
"Permissions" and any linked security-architecture design). An APPROVED classification is scoped
to the exact version/commit recorded — a version bump requires re-review, not an automatic
carry-forward.

## Classifications

- **APPROVED** — reviewed, safe to use as documented, under its recorded conditions.
- **EXPERIMENTAL** — usable in a controlled/project-scoped way, not a standing dependency.
- **REVIEW** — provenance/security not yet independently verified; do not install.
- **REJECTED** — reviewed and found unsuitable; do not install.
- **RESEARCH-ONLY** — architecture/concepts may be studied and documented; code must not be
  copied into Syveka (e.g. incompatible license).

## Entries

### Scrapling

| Field                   | Value                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                    | Scrapling                                                                                                                                                                                                                                                                                                                               |
| Owner/maintainer        | Karim Shoair (`D4Vinci`)                                                                                                                                                                                                                                                                                                                |
| Official source         | https://github.com/D4Vinci/Scrapling                                                                                                                                                                                                                                                                                                    |
| Version / commit        | `0.4.14` / `5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f` (tag `v0.4.14`)                                                                                                                                                                                                                                                                   |
| License                 | BSD 3-Clause                                                                                                                                                                                                                                                                                                                            |
| Purpose                 | Adaptive web scraping: plain HTTP, JS-rendered browser, and stealth/anti-bot fetch tiers; CSS/XPath parsing; spider/crawl framework; structured extraction                                                                                                                                                                              |
| Supported agents        | Model-agnostic via its official MCP server (`io.github.D4Vinci/Scrapling`, stdio transport) — usable from Claude Code, and any other MCP-compatible client (Codex, Gemini CLI, Cursor, etc.) once they're configured to launch it. Also ships an official Agent Skill (`agent-skill/Scrapling-Skill/`) authored by the same maintainer. |
| Install location        | Not installed into this repository or any host machine as part of this review. Verified via a disposable Docker container (`ghcr.io/d4vinci/scrapling:latest`) only.                                                                                                                                                                    |
| Scripts                 | `scrapling` (CLI) and `scrapling-mcp` (MCP server) console entry points; no custom install-time scripts beyond a standard `setuptools` build                                                                                                                                                                                            |
| Hooks                   | None found (no git hooks, no lifecycle scripts beyond the standard Python build backend)                                                                                                                                                                                                                                                |
| Allowed tools (MCP)     | 10 tools: `get`, `bulk_get`, `fetch`, `bulk_fetch`, `stealthy_fetch`, `bulk_stealthy_fetch`, `open_session`, `close_session`, `list_sessions`, `screenshot` — see `docs/skills/SECURITY_REVIEW.md` for per-tool detail                                                                                                                  |
| MCP permissions         | Network egress (arbitrary target URLs, scoped by whatever allowlist the host/wrapper enforces — none by default); optional proxy/CDP connection if explicitly supplied by the caller; no filesystem access beyond an explicit output path in CLI mode                                                                                   |
| Network access          | Yes — this is the tool's entire purpose. Built-in SSRF mitigation (`follow_redirects="safe"`) covers the plain-HTTP engine only; browser-based tools have no equivalent built-in protection — see Security Review §"Network behavior"                                                                                                   |
| Credential requirements | None required for core functionality. Proxy auth / CDP URL / cookies are optional, caller-supplied only                                                                                                                                                                                                                                 |
| Dependencies            | Core: `lxml`, `cssselect`, `orjson`, `tld`, `w3lib`. Optional (`fetchers`/`ai`/`shell` extras): `curl_cffi`, `playwright`, `patchright`, `browserforge`, `mcp`, `markdownify`, others — see `pyproject.toml`                                                                                                                            |
| Risk level              | Medium — well-governed, transparent, permissively licensed, with real (if partial) built-in safety defaults; risk concentrated in its dual-use stealth/anti-bot-bypass capability and in browser-tool SSRF coverage, both addressed by mandatory conditions, not by rejecting the tool                                                  |
| Syveka classification   | **APPROVED REFERENCE / HIGH PRIORITY**, conditional (see Security Review conditions)                                                                                                                                                                                                                                                    |
| Installed status        | Not installed. Verified via disposable container only; no standing dependency added to any Syveka service                                                                                                                                                                                                                               |
| Last reviewed           | 2026-08-19                                                                                                                                                                                                                                                                                                                              |
| Update strategy         | Re-review required before adopting any newer version/commit than the one pinned above. No automatic update.                                                                                                                                                                                                                             |

**Recorded architecture recommendation**: use via its official MCP server (Option B) or Agent
Skill (Option C) for interactive, human-supervised research today; an isolated microservice
(Option D) only if/when a concrete Syveka product feature needs scraping — see
`docs/skills/scrapling-integration.md` for the full evaluation, security-control design, and the
provider-agnostic `syveka-web-research` pipeline concept this could sit behind.
