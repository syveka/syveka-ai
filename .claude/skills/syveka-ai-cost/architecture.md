# Syveka AI gateway — target architecture (notes, not implemented)

Status: **design notes only.** Nothing here exists in code beyond what `SKILL.md` lists. Each
phase below is a separate, independently approved and tested PR.

```
SYVEKA FEATURE            (services: chat, extract, voice, creator captions, …)
  ↓ task + orgId + plan + constraints
SYVEKA AI GATEWAY         (single entry: budget check, usage logging, error normalization)
  ↓
TASK CLASSIFICATION       (existing AiTask enum; extend, don't rename)
  ↓
MODEL ROUTER              (routeModel: task × plan × capability × availability → ordered candidates)
  ↓
MODEL REGISTRY            (ROUTES + price table: provider, model, maxTokens, capabilities, $/Mtok)
  ↓
PROVIDER ADAPTERS         (anthropic.ts, openai.ts, openrouter.ts — uniform stream/complete signature)
```

## Routing inputs

task complexity · required capabilities (tools, vision, JSON, context length) · quality bar ·
token volume · latency budget · model availability/health · cost · fallback requirement ·
customer plan · safety/data-residency requirements (EU customers; `fra1` deploy region).

## Phased plan

1. **Registry metadata** — add optional `capabilities` + price to registry entries; move
   `cost.ts` prices next to routes (single source). Tests: every route has a price.
2. **Usage logging** — one `recordAiUsage({orgId, task, provider, model, tokensIn, tokensOut,
costUsd})` used by all call sites (extends `UsageRecord.metadata`, no schema change if possible).
3. **Cost analytics** — per-org/per-task aggregation in the existing `usage-rollup` job.
4. **Budget guardrails** — per-plan soft/hard monthly caps checked in the gateway; fail with a
   clear, localized error; never silently downgrade a paid feature without a flag.
5. **OpenRouter provider** — `provider: "anthropic" | "openai" | "openrouter"`;
   `src/server/integrations/openrouter.ts` behind the same adapter signature; scoped
   `getOpenRouterEnv()` in `src/env.ts` (fails closed; `OPENROUTER_API_KEY` never logged);
   initially opt-in per route for low-risk background tasks only.
6. **Fallback** — wire `withModelFallback()` per call site with tests; ordered candidates from the
   router; log fallback events.

## Trade-offs to present before phase 5

- OpenRouter: + one key for many models, cheap/free options, availability routing; − extra
  intermediary for customer data (DPA/retention review needed), variable model behavior, price
  drift, another failure point. Keep direct Anthropic/OpenAI adapters as primary for PII-bearing
  and high-value tasks.
- Alternatives: direct multi-provider adapters only (more integration work, fewer intermediaries);
  self-hosted gateway (LiteLLM-style; more ops burden).

## Invariants

- Provider choice never leaks into business logic; services call the gateway with a task.
- No prompt hardcoded outside `src/server/ai/prompts/`.
- Every call bounded by `maxTokens`, timeout, and retry policy; usage recorded per org.
- No model-specific assumptions (context size, output format) without explicit approval.
