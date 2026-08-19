# Syveka Master Skill — Commercialization Opportunities

Documentation only, as instructed by the product brief: "Do NOT build billing now. Document
commercialization opportunities only." Nothing in this document is implemented in this codebase.

## Working product name

**Syveka Master Skill** for the underlying engine/library; **Syveka Skills Platform** for the
eventual hosted/commercial product built on top of it. Other names evaluated and set aside for
now (not because they're wrong, but because naming isn't the current bottleneck, per the brief):
Syveka SkillOS, Syveka AgentOS, Syveka Skill Router, Syveka Agent Toolkit, Syveka Skill Engine,
Syveka Professional Agent Layer.

## Why this is a plausible product, not just an internal tool

The differentiated layer identified in `docs/product-vision.md` - capability routing, a trust
registry, permissions, human approvals, evidence, verification, security scanning, provider
abstraction, audit trail, cross-model adapters - is exactly the set of concerns every team
adopting AI coding/business agents eventually has to build for themselves, badly, once, under
deadline pressure. Packaging it once, well, model-agnostically, is the opportunity.

## Potential customers

- Software teams adopting Claude Code/Codex/Gemini CLI who need governance, not just capability.
- AI agencies delivering agent-based work to clients who will ask "how do we know it actually
  worked" and "what did the agent have access to."
- SMEs who want AI leverage without a dedicated platform/security team to build guardrails.
- Enterprise AI teams who already have compliance requirements agent tool-calling doesn't meet
  out of the box.
- Consultants who need to demonstrate evidence-backed delivery, not just "I asked the agent and it
  said it was done."
- Regulated businesses (finance, healthcare, legal-adjacent) where an unverifiable AI completion
  claim is a real liability, not just an inconvenience.

## Potential plan structure

| Plan           | Scope                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| **FREE**       | Basic open Skill Registry + local runner - the core of what this MVP implements                             |
| **PRO**        | Professional skills, verification, security scanning as a managed service                                   |
| **TEAM**       | Shared registry, org-wide policies, approvals, audit logs, team management                                  |
| **ENTERPRISE** | Private skills, RBAC, SSO, compliance reporting, private registries, central governance, full policy engine |

This maps cleanly onto architecture already present in this MVP: `core/registry` is FREE-tier
today (static array); a database-backed, org-scoped version is the TEAM/ENTERPRISE evolution
already anticipated in `docs/skills-registry.md`'s "Production evolution path." `core/permissions`

- `core/approvals` are the seed of a policy engine; a real approval transport plus RBAC/SSO would
  be the ENTERPRISE version of the same two modules, not a rewrite.

## The specific commercial angle called out in the brief: Skill security scanning

The product brief flags this explicitly: _"This feature has strong future commercial value."_
`docs/skills/SECURITY_REVIEW.md`'s methodology (provenance, license, dependencies, install
scripts, network/filesystem/subprocess behavior, credential handling, prompt-injection exposure)
was applied by hand to Scrapling in this Skills Lab work. Turning that checklist into an automated
`PASS` / `PASS_WITH_CONDITIONS` / `REVIEW_REQUIRED` / `REJECT` scanning pipeline - callable as a
capability (`skill.security_review`), not just a manual doc - is a standalone product surface
regulated and unregulated customers alike would plausibly pay for independent of the rest of the
orchestration layer. Not built in this MVP; see `docs/mvp.md`'s recommended next milestone.

## Risks to commercial viability, stated honestly

- The evidence/verification model's guarantees are real but narrow (see
  `docs/evidence-model.md` "What this model does not claim") - overselling it as "proof the AI
  didn't lie" rather than "proof the claimed evidence exists and is structurally sufficient" would
  be a credibility risk with a technical customer base.
- Model-agnosticism is currently proven only for Claude Code (a real adapter); Codex and Gemini
  adapters are unverified format translations - a customer relying on those before they're tested
  against live CLIs would hit real integration bugs this MVP cannot rule out.
- The registry's trust model depends on Syveka actually doing the review work
  (`docs/skills/SECURITY_REVIEW.md`-style) for every capability a customer wants - this doesn't
  scale for free; it's the PRO/TEAM tier's actual cost basis, not overhead to eliminate.
