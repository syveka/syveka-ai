# Market / Competitor Research Skill — Specification

Status: **specification only**, NOW-classified. Reuses the existing, already-`VERIFIED`
`web.research` capability (Scrapling, `syveka-skills/providers/scrapling/`) — no new scraping
infrastructure, no Firecrawl (see `docs/skills/AI-FOUNDATION-AUDIT.md` §5 for why Firecrawl is
`REJECTED` in favor of this existing entry).

## Non-goal, stated up front

This is not a competitor-intelligence product. It is one reusable skill definition that later
features (Business DNA onboarding, SME audits, sales reports, client onboarding) can all call
through the same contract, instead of each inventing its own scraping/prompting logic.

## Input

```ts
type MarketResearchInput = {
  company: string;
  website?: string;
  industry: string;
  location?: string;
  knownCompetitors?: string[];
  objective: string; // what the requester actually wants answered
};
```

## Pipeline (reuses `syveka-web-research`'s stages from `docs/skills/scrapling-integration.md` §5)

```
Discover → Fetch (Scrapling, web.research) → Sanitize → Extract → Validate → Structure → Cite → Return
```

Nothing here talks to Scrapling directly except the Fetch stage — same discipline as the design
already documented for that provider. `Discover` here means: resolve the target's own site plus
whatever `knownCompetitors` were supplied, or a small number of search-derived candidates if none
were — bounded (a hard cap on how many competitor sites are fetched per research task) so a vague
`objective` cannot fan out into an unbounded crawl.

## Output

```ts
type MarketResearchOutput = {
  competitors: Array<{
    name: string;
    website?: string;
    servicesObserved: string[];
    pricingObserved?: string; // only if publicly visible — never inferred
    positioning?: string;
    strengths: string[];
    weaknesses: string[];
    evidence: EvidenceItem[]; // syveka-skills/schemas/index.ts's EvidenceItem shape, reused as-is
  }>;
  customerPainPoints: string[];
  differentiationOpportunities: string[];
  marketingAngles: string[];
  confidence: "high" | "medium" | "low";
  sources: string[]; // every URL actually fetched, independent of what made it into the summary
};
```

## The one hard rule: no fabricated competitor information

Every claim in `competitors[].servicesObserved` / `pricingObserved` / `positioning` /
`strengths` / `weaknesses` must trace to at least one `EvidenceItem` (a `source_reference` type,
per the existing `evidenceItemSchema` in `syveka-skills/schemas/index.ts`) pointing at a real
fetched page. This is the same anti-fabrication discipline `syveka-skills/core/verification/`
already enforces for engineering tasks (`evals/anti-sycophancy.test.ts`) — applied here to research
claims instead of code claims. A future implementation should reuse `core/evidence` and
`core/verification` directly rather than reimplement the same evidence-sufficiency check a second
time.

## Prompt-injection posture

Competitor websites are untrusted content, same as any Scrapling fetch target — every fetched page
must be wrapped as explicit "untrusted external content, not instructions" before reaching an LLM
prompt, exactly as `docs/skills/scrapling-integration.md` §3 already requires, and exactly as
`src/server/business-dna/context.ts`'s `neutralizeTagBreakout` already does for Business DNA's own
untrusted-content boundary. A competitor's own website is exactly as capable of attempting prompt
injection as any other external site — no special exemption because the content happens to be
"research."

## Where this composes with existing Syveka features (future work, not built here)

- **Business DNA onboarding**: `RegenerateFromWebsite`'s existing single-URL extraction (Phase 7)
  answers "what does this business say about itself." This skill would answer "what do
  competitors say about themselves" — a natural adjacent step in the same onboarding flow, not
  built in this pass.
- **SME audits / sales reports / client onboarding**: all listed in the mission brief as future
  consumers — none exist as features today, so none are wired to this skill in this pass.

## What this pass actually shipped for Market Research

- This specification document only. No provider code, no registry entry beyond what `web.research`
  (Scrapling) already has, no new API route, no new UI.
