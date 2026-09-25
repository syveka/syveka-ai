---
name: syveka-ai-cost
description: Syveka AI cost and model-routing work — estimate the cost of AI call sites, choose the right model tier for a task, review routing/fallback/usage-logging/budget-guardrail changes, and plan adding OpenRouter as another provider inside the existing router (never replacing it). Use when a change adds or modifies an LLM call, touches src/server/ai/router.ts or cost.ts, or asks about AI spend.
argument-hint: "[call site | feature | question]"
hooks:
  PreToolUse:
    - matcher: "Bash|PowerShell|mcp__github__.*"
      hooks:
        - type: command
          command: "node .claude/skills/syveka-context/scripts/prod-guard.mjs"
---

# syveka-ai-cost

Request: `$ARGUMENTS`. Follow [guardrails](../syveka-context/references/guardrails.md).
Target architecture and OpenRouter plan: [architecture.md](architecture.md) (read only when
planning routing/provider changes).

## Current system (verify before relying on it)

- `src/server/ai/router.ts` — `AiTask` → `{provider, model, maxTokens}` (`ROUTES`), `routeModel()`,
  unused `fallbackModel()`. **This is the model registry. Extend it; do not replace it.**
- `src/server/ai/cost.ts` — `estimateAiCost(model, {tokensIn, tokensOut})`, regex price table,
  default price for unknown models.
- `src/server/ai/fallback.ts` — `withModelFallback()` scaffolding, not wired into call sites.
- `src/server/ai/retry.ts` — shared retry policy (`AI_RETRY_*`).
- Providers: `src/server/integrations/anthropic.ts` (chat), `openai.ts` (embeddings/moderation).
- Usage: `UsageRecord` (`prisma/schema.prisma`), writers in `services/conversations.ts`,
  `billing/entitlements.ts`, `creator-credits.ts`; rollup job `api/v1/jobs/usage-rollup`.

## Modes

**COST ESTIMATION** — for a call site: task → route → model; typical `tokensIn`/`tokensOut`
(prompt + RAG context + history); calls per user action × expected volume; `estimateAiCost` per
call → monthly figure. State assumptions explicitly; mark as ESTIMATE.

**MODEL SELECTION** — pick the cheapest tier that meets quality/safety/latency needs:

| Work                                                           | Tier                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| classification, titles, sentiment, extraction, short summaries | `utility`/`title`/`sentiment`/`summary` (small model) |
| conversational, drafting, tool use                             | `chat` / `draft`                                      |
| complex reasoning, high-value, low volume                      | `deep`                                                |
| unauthenticated/public                                         | `publicAssistant` (cheapest, capped)                  |

Cheap/free models only for low-risk background work with no customer PII unless the provider's
data terms are approved. Premium stays available for complex/high-value tasks.

**REVIEW** (routing/cost changes) — no hardcoded model ids at call sites; `maxTokens` bounded;
retries bounded; usage recorded per org; price table updated for any new model; provider-specific
types don't leak into services; failure degrades with a clear error (CLAUDE.md §7).

## Out of scope unless explicitly approved

Implementing OpenRouter, changing `ROUTES` models, wiring fallback, new budget enforcement, or any
env/secret addition. Produce a plan + trade-offs (CLAUDE.md §5) and stop for approval.
