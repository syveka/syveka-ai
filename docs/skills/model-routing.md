# Model Routing — What Exists, What This Pass Adds

Syveka's product-facing model router already exists at `src/server/ai/router.ts` — this document
explains it and records one real gap in it. **This pass adds opt-in scaffolding toward closing
that gap (`src/server/ai/fallback.ts`) — it does not close it.** No production call site uses this
scaffolding; cross-provider failover is **NOT WIRED** into any live product path today. See "What
this pass adds" below for the precise, non-overstated claim.

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

## What this pass adds: `src/server/ai/fallback.ts` — opt-in control-flow scaffolding, NOT wired

**This is scaffolding, not operational failover.** A new, tested, currently-unused utility —
`withModelFallback()` — that a call site _may_ adopt in a future, separate, independently-tested
PR. As of this PR: no production call site imports or calls it; no product-level cross-provider
failover exists or is claimed to exist. `src/server/integrations/openai.ts` still has no chat-
completion execution path (only embeddings/moderation) — adding one, and wiring it as an automatic
alternate for the 8 existing Anthropic call sites, is deliberately out of scope here and would need
its own focused PR with its own tests, not a claim folded into this foundation pass.

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

| Condition                                   | Handled by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider unavailable / rate limit / timeout | `isTransientAiError` (existing, reused) — checks HTTP 408, 409, 429, any `>=500`, and a fixed set of network-error codes (`ECONNRESET`, `ETIMEDOUT`, `ENETUNREACH`, `rate_limit_exceeded`, `server_error`). Verified by reading `src/server/ai/retry.ts` directly, not assumed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Model unavailable (404 / invalid model id)  | **NOT currently transient — corrected from an earlier draft of this document, which incorrectly stated 404 was treated as transient.** `isTransientAiError` does not special-case 404, and 404 is neither `>= 500` nor in the network-error-code set, so `withModelFallback` will **not** fail over on a 404 today; the error propagates. This is deliberate, not an oversight fixed in this pass: a 404 far more often means bad configuration (a typo'd or deprecated model id) than a transient provider condition, and silently failing over would hide that misconfiguration instead of surfacing it. Expanding the classifier to treat 404 as transient is a separate, focused decision that needs its own review — not a side effect of this documentation correction. |
| Budget constraint                           | Per-call cost _estimation_ already exists (`src/server/ai/cost.ts`'s `estimateAiCost`/`estimateAiCostUsd`, used in the chat route and `conversations.ts`) — but nothing enforces a ceiling from it today; it's observability, not a budget gate. Out of scope for this pass; the natural place a future budget check would live is alongside the existing `recordUsage`/billing-entitlements system, not a new mechanism                                                                                                                                                                                                                                                                                                                                                      |
