# Syveka Master Skill — Product Vision

## What this is

Syveka Master Skill is a reusable, model-agnostic orchestration, governance, evidence, and
verification layer for AI agents. It turns a general-purpose coding/business agent into a
structured, evidence-driven professional agent by sitting between "the agent has an intent" and
"the agent takes an action."

## What this is not

Syveka is **not** "a folder containing lots of downloaded skills." Bundling third-party Agent
Skills, MCP servers, and frameworks together is not the product — it's raw material. The product
is the layer that decides, for every task:

1. What capability is required.
2. Which approved skill/tool should perform it.
3. What permissions are required.
4. Whether owner approval is needed.
5. What evidence proves completion.
6. Whether another skill should verify the result.
7. What gets recorded in the audit/report.

## The core loop

```
User Intent
  -> Understand
  -> Classify Task
  -> Plan
  -> Select Capability
  -> Select Approved Skill / Tool
  -> Check Permissions
  -> Execute
  -> Test
  -> Verify
  -> Challenge Weak Claims
  -> Report Evidence
```

Every arrow in that diagram is a real, implemented, tested module in this MVP (`core/`) — not
aspirational. See `docs/architecture.md` for the concrete mapping.

## Why this is defensible as a product, not just glue code

Anyone can write a script that calls a scraper, a UI generator, and a test runner in sequence.
What's hard to build — and what a third-party Skill/MCP does not provide on its own — is:

- A **capability abstraction** that survives a provider being swapped, banned, or going down.
- A **trust registry** where "discovered" and "approved" are different states, always.
- A **permission model** that fails closed on anything unclassified.
- An **evidence model** that structurally cannot be talked out of its verdict by user pressure,
  confident prose, or injected instructions from scraped content.
- A **cross-model adapter layer** so this isn't Claude-specific.
- An **audit trail** with secrets scrubbed unconditionally, not by convention.

None of Scrapling, shadcn MCP, 21st.dev, the Anthropic Skill Creator, or Superpowers provide any
of that — they are capabilities and methodologies this layer _orchestrates_, never trusts blindly,
and never becomes dependent on. See `docs/provider-model.md`.

## Initially supported agents

Claude Code, OpenAI Codex, Gemini CLI — with Cursor, Copilot, Windsurf, OpenCode, and other
Agent-Skills-compatible systems as future targets. The core (`core/`, `schemas/`, `policies/`) has
zero agent-specific code; only `adapters/` knows about a specific target format. See
`docs/architecture.md` "Adapter architecture."

## Where the LLM fits

This orchestrator does not replace the calling agent's reasoning — it structures it. In real
usage, the host LLM agent (Claude Code, Codex, Gemini CLI) reads the capability taxonomy and
performs the actual intent understanding and code-writing; this codebase provides the
deterministic, testable, non-negotiable parts: routing, permission gates, evidence requirements,
and verification. See `core/intent/index.ts`'s module doc comment for the precise boundary.
