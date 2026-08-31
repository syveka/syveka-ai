# Model Routing — What Exists, What This Pass Adds

Syveka's product-facing model router already exists at `src/server/ai/router.ts` — this document
explains it and records the one gap this pass closes additively.

## The existing router

```ts
type AiTask = "chat" | "deep" | "utility" | "title" | "sentiment" | "summary" | "draft";

function routeModel(task: AiTask, pinnedModel?: string | null): ModelChoice; // { provider, model, maxTokens }
function fallbackModel(): ModelChoice; // { provider: "openai", model: "gpt-4o", ... }
```

Config-driven (`ROUTES` map), provider-agnostic at the type level (`provider: "anthropic" |
"openai"`), supports a per-conversation pinned-model override. Mapped against this mission's
suggested task classes:

| Mission's suggested class                   | Existing `AiTask`                        | Model today               |
| ------------------------------------------- | ---------------------------------------- | ------------------------- |
| high_reasoning / architecture               | `deep`                                   | Opus 4.8                  |
| coding / conversational                     | `chat`                                   | Sonnet 4.5                |
| extraction / classification / summarization | `utility`                                | Haiku 4.5                 |
| copywriting (short)                         | `title`                                  | Haiku 4.5                 |
| QA / security_review                        | _(none yet — `deep` is the closest fit)_ | —                         |
| low_latency                                 | `sentiment`                              | Haiku 4.5 (16 max tokens) |

No renaming was done — the existing 7-value union already implements the mission's cost/quality
tiering principle ("high complexity → strongest model, simple extraction → cheaper/faster model")
under names already used across 8 production call sites. Renaming them for cosmetic alignment with
this document's table would be exactly the kind of "rewrite a stable system to fit a new
abstraction" the mission explicitly says not to do.

## The one real gap: fallback was designed but never wired

`fallbackModel()` is exported and unused — confirmed by a repo-wide call-site search. The doc
comment on `streamClaude()` (`src/server/integrations/anthropic.ts`) already states the intent:
_"Providers are wrapped behind this uniform signature so the model router can fail over to
OpenAI"_ — but no code path does that failover today. `src/server/integrations/openai.ts` exists
and is used for embeddings/moderation only, never chat completion.

## What this pass adds: `src/server/ai/fallback.ts` (additive, opt-in, zero behavior change today)

A new, tested utility — `withModelFallback()` — that a call site _may_ adopt to get real
failover, without any existing call site being touched in this pass:

```ts
export async function withModelFallback<T>(
  primary: () => Promise<T>,
  onFallback: (fallback: ModelChoice) => Promise<T>,
): Promise<T>;
```

It runs `primary()`; if it throws a transient-looking error (reusing the existing
`isTransientAiError` classifier from `src/server/ai/retry.ts` — no new error-classification logic),
it calls `onFallback(fallbackModel())` instead of propagating the failure. If `primary()` throws a
non-transient error (e.g. a genuine 400 from bad input), it propagates immediately — falling back
to a different provider would not fix a malformed request.

**Why not wire it into the 8 existing call sites in this pass**: each one has its own error-handling
shape today (some stream to a client, some run inside a QStash job with its own retry semantics,
some are synchronous helpers). Wiring fallback into all eight in one foundation pass, without
individually re-verifying each one's behavior under a simulated Anthropic outage, is a correctness
risk disproportionate to a "foundation" change. `src/server/ai/fallback.ts` exists, is unit-tested,
and is ready for the first real call site to adopt in its own focused PR — this pass provides the
tool, not the elimination of the last mile.

## Fallback trigger conditions (matches Phase 4's list)

| Condition                                   | Handled by                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider unavailable / rate limit / timeout | `isTransientAiError` (existing, reused)                                                                                                                                                                                                                                                                                                                                                                                  |
| Model unavailable                           | Same — a 404/model-not-found from the SDK is treated the same as any other transient provider failure by the existing classifier                                                                                                                                                                                                                                                                                         |
| Budget constraint                           | Per-call cost _estimation_ already exists (`src/server/ai/cost.ts`'s `estimateAiCost`/`estimateAiCostUsd`, used in the chat route and `conversations.ts`) — but nothing enforces a ceiling from it today; it's observability, not a budget gate. Out of scope for this pass; the natural place a future budget check would live is alongside the existing `recordUsage`/billing-entitlements system, not a new mechanism |
