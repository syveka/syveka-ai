# Perplexity API — Research Provider Evaluation (not installed)

Companion to `docs/skills/SKILLS_REGISTRY.md`, `docs/skills/market-research-skill.md`, and
`syveka-skills/core/registry/data.ts`'s `perplexity` entry. Same evaluation format as
`docs/skills/chrome-devtools-mcp-evaluation.md` — a design/evaluation document with verified
vendor facts, a real security/data posture, and a real benchmark PoC design, but **nothing here is
installed, connected, or wired into Syveka**.

## Status

**P2 — OPTIONAL RESEARCH PROVIDER.** Registered in `syveka-skills/core/registry/data.ts` as
`perplexity`, capability `research.cited`, `status: REVIEW`, `integration_state: REFERENCE`. Not
routable until the conditions in §3 are met. **Perplexity must never become the default AI model**
— it is a specialized, opt-in research provider, reached only through the `research.cited`
capability, never substituted for `src/server/ai/router.ts`'s existing model routing.

## 1. What it is

The [Perplexity API platform](https://docs.perplexity.ai) (re-checked 2026-09-07) is a hosted,
proprietary commercial API — not open source, so there is no OSI license to cite; use is governed
by Perplexity's own commercial terms. It offers several services: the **Agent API** returns
"web-grounded answers with built-in citations in one call" (the successor to what was previously
called Sonar Chat Completions); the **Search API** returns raw, ranked web search results; a
**Router** and **Embeddings** API are also offered. Authentication is a Bearer API key
(`Authorization: Bearer $PERPLEXITY_API_KEY`) obtained from `console.perplexity.ai`. No first-party
MCP server offering was found for Perplexity as of this review — a real integration would be a
direct HTTP client, not an MCP session (contrast Composio/Scrapling, both of which do offer an MCP
path).

**Cost model** (re-checked 2026-09-07, not authoritative — re-verify before any spend decision):
Sonar-family models combine per-request search fees (roughly $5–$14 per 1,000 requests depending on
model and search-context size) with separate token pricing (roughly $1–$3 per million input tokens
on the base tiers). The per-request fee can dominate total cost on short queries — a caller cannot
reason about cost from token pricing alone. Any production adoption needs its own per-call budget
and rate limit, using Syveka's existing shared rate-limiting infrastructure
(`CLAUDE.md` §4's "rate-limit every ... cost-amplifying ... endpoint" rule), not an ad hoc one.

## 2. Why this is not a duplicate of Scrapling's `web.research`

`docs/skills/market-research-skill.md` already documents a research pipeline built entirely on
Scrapling's `web.research` capability (`Discover → Fetch → Sanitize → Extract → Validate →
Structure → Cite → Return`), and `docs/skills/AI-FOUNDATION-AUDIT.md` explains why Firecrawl was
**REJECTED** for duplicating that exact capability. Perplexity is a genuinely different shape, not
a second implementation of the same job:

|                 | Scrapling (`web.research`)                                                                                            | Perplexity (`research.cited`)                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| What it returns | Raw fetched/extracted page content (HTML/markdown) from URLs Syveka chooses                                           | An AI-synthesized answer to a question, with citations, aggregated across sources Perplexity chooses                                    |
| Syveka's role   | Fetch, then Syveka's own pipeline extracts/validates/structures/cites                                                 | Consume an already-synthesized, already-cited answer                                                                                    |
| Isolation       | Real Docker-isolated fetch, real SSRF policy, no third party sees the extracted content beyond the target site itself | Query text is sent to a third-party AI provider, which also sees it                                                                     |
| Best fit        | Targeted extraction from known/discoverable URLs (a competitor's own site)                                            | Broad, current, cross-source questions where the right sources aren't already known ("what's the current market size for X in Finland") |

This is the same "complementary, not duplicate" reasoning
`docs/skills/chrome-devtools-mcp-evaluation.md` already applied to Chrome DevTools MCP vs.
Playwright — not a rationalization invented for this entry.

## 3. Required conditions before this can move past REVIEW/REFERENCE

1. A provisioned `PERPLEXITY_API_KEY`, added to `.env.example` and real environment configuration
   only once actual runtime integration code exists — not before (see §6).
2. A **data-minimization review**: exactly what query text is allowed to leave Syveka to this
   third party, with sensitive/private tenant data excluded by construction, not by convention.
3. Citation/source preservation implemented end-to-end — any consumer of a Perplexity result must
   retain and surface the sources, never present a synthesized answer as if it were Syveka's own
   unsourced claim.
4. A **freshness and source-quality assessment** layer — Perplexity's own citations are the input,
   but a consuming feature (e.g. Business DNA enrichment) must still be able to reason about how
   recent and how authoritative each cited source is, the same anti-fabrication discipline
   `docs/skills/market-research-skill.md` §"The one hard rule" already requires for Scrapling-based
   research.
5. Explicit separation between Perplexity-sourced (external) research and Syveka's own
   authoritative customer/business data (`src/server/business-dna/context.ts`) — external research
   augments, it never silently overwrites or gets merged indistinguishably into Business DNA.
6. Cost-aware call budgeting and rate limiting (§1), using Syveka's shared limiting
   infrastructure.
7. A provider fallback: if Perplexity is unavailable/degraded, the calling feature degrades
   gracefully (reports research as unavailable, or falls back to the existing
   `web.research`/Scrapling pipeline where applicable) — never hangs, never silently fabricates a
   research result, per `CLAUDE.md` §7's AI-provider-degradation rule.
8. The benchmark PoC in §7 actually run and its results documented before any product surface is
   allowed to call this capability for real.

## 4. When an agent SHOULD use Perplexity

- Current web information is required (something that changes over time — pricing, news, a
  company's current status — not a static fact).
- Source-backed research is important and the requester needs to see citations, not just an
  answer.
- Competitor/market research specifically needs citations attached to each claim.
- Business DNA needs external enrichment beyond what the tenant's own website/CRM data provides.

## 5. When an agent must NOT use Perplexity

- The information already exists in Syveka (Business DNA, CRM, prior research) — check there
  first; do not re-research externally what Syveka already authoritatively knows.
- Business DNA already contains authoritative customer-supplied data on the same question —
  external research must never silently override a tenant's own stated facts.
- A normal model request (`src/server/ai/router.ts`'s existing chat/deep/utility routing) is
  sufficient — Perplexity is for research questions requiring current, cited, external
  information, not a general-purpose model substitute.
- Sensitive or private tenant information would unnecessarily leave Syveka to answer the question.
- The task does not require web research at all.

## 6. Security posture (evaluated, not live-tested)

- No live connection in this environment: no `PERPLEXITY_API_KEY` provisioned, no call made, no
  account touched to produce this document.
- `providers/perplexity/index.ts` is an honest `createUnavailableStubProvider` — reports
  `UNAVAILABLE` rather than a fabricated success.
- Risk classified `MEDIUM` (`core/registry/data.ts`): read-only, no OAuth, no write access to any
  system — but query text leaving Syveka to a third-party AI provider is real data exposure that
  must be reviewed (§3.2) before production use, so `LOW` would understate it.
- No `.env.example` entry added for `PERPLEXITY_API_KEY` in this pass — consistent with §3.1 and
  this task's own instruction not to add credentials no runtime code yet reads.
- Prompt-injection posture: a Perplexity response, like any external content, must be treated as
  untrusted data if it is ever passed into a further LLM prompt — not as instructions — the same
  discipline `docs/skills/scrapling-integration.md` §3 and
  `src/server/business-dna/context.ts`'s `neutralizeTagBreakout` already apply to other untrusted
  external content.

## 7. Benchmark PoC design (not executed — design only, per this task's scope)

Research one real Finnish SME (a concrete, already-known business, not a fabricated example) via
two paths and compare:

- **A. Existing Syveka research path** — the `web.research`-based pipeline described in
  `docs/skills/market-research-skill.md`.
- **B. Perplexity** — the same research question(s) sent to the Agent/Search API.

Compare, and report honestly rather than assume a winner:

- Factual accuracy (spot-checked against known-true facts about the SME)
- Citations (present? traceable to real, checkable sources?)
- Freshness (how current is the information each path surfaces?)
- Latency
- Cost (per the pricing model in §1 — actual measured cost for this benchmark, not a projection)
- Completeness (does it answer the actual research objective, not just produce text?)
- Hallucinations (any claim not traceable to a real source, from either path)
- Usefulness for Business DNA specifically (would this genuinely improve an onboarding/enrichment
  flow, or just add cost?)

**Do not declare Perplexity superior — or adopt it for any product surface — without this
benchmark's evidence.** This mirrors the exact anti-sycophancy discipline
`syveka-skills/core/verification/` already enforces for engineering claims
(`evals/anti-sycophancy.test.ts`), applied here to a vendor-comparison claim instead of a code
claim.

## 8. What this pass actually shipped

- This evaluation document.
- One registry entry (`syveka-skills/core/registry/data.ts`, `perplexity`, `status: REVIEW`,
  `integration_state: REFERENCE`).
- One honest stub provider (`syveka-skills/providers/perplexity/index.ts`).
- Evals proving the stub is honestly unavailable, non-routable, and that it claims a distinct
  capability (`research.cited`) rather than colliding with Scrapling's `web.research`
  (`syveka-skills/evals/composio-perplexity-providers.test.ts`).
- No API key provisioned, no `.env.example` change, no live call made, no benchmark executed.
