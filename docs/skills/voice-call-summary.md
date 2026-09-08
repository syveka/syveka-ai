# Voice Call Summary — the first Syveka Skill proven end-to-end

Registry entry: `syveka-skills/core/registry/data.ts`, `id: "voice-summary"`,
capability `voice.summarize`. Companion evidence: `syveka-skills/evals/voice-call-summary.test.ts`
(44/44 PASS, deterministic, no network, no API key).

**Capability id**: `voice.summarize` · **Status**: `REVIEW` · **Integration state**: `REFERENCE`
· **Trust level**: `CONDITIONAL` · **Risk level**: `MEDIUM`

## What this milestone proves — and what it doesn't

This milestone's goal was proving the Syveka Skills architecture itself works end-to-end for a
real capability: **Skill contract → input validation → registry resolution → permission/risk
evaluation → provider execution boundary → output validation → verification → audit/reporting**.
It deliberately does **not** ship a live AI-calling connection - no new external integration was
introduced, per this milestone's explicit scope. The registered provider
(`syveka-skills/providers/voice-summary/index.ts`) is an honest, always-unavailable stub, same
shape as `composio`/`perplexity`/`shadcn-mcp` elsewhere in the registry - `status: REVIEW`,
`integration_state: REFERENCE`. It is not routable today, and this document does not claim
otherwise.

## Relationship to the existing production pipeline

Syveka already has a real, working, production call-summary pipeline:
`src/app/api/v1/jobs/post-call/route.ts`. It calls Anthropic directly, writes `VoiceCall.summary`/
`sentiment`/`actionsTaken`, creates a CRM `Activity`, sends an owner notification, and emits a
`call.completed` workflow event - with careful idempotency guards against QStash retries. **This
Skill does not replace, wrap, or modify that pipeline.** They are currently two independent things:
one is live production code handling real tenant data; the other is a Skill-architecture proof
using a deterministic test double. Whether/how they should eventually relate (the Skill becomes the
real implementation behind that route, vs. staying a separate reusable capability) is an open
question for a future milestone, not decided here.

## The Skill contract

**Input** (`providers/voice-summary/schema.ts`, `.strict()` at every object level - an unexpected
key is a hard rejection, not a silently-dropped extra):

```ts
{
  transcript: string;      // 1-50,000 chars, not whitespace-only - the observed source of truth
  callId: string;          // safe correlation identifier, opaque to this Skill
  language?: "en" | "fi" | "unknown"; // defaults to "unknown"
  metadata?: { durationSeconds?: number };
}
```

No field can carry provider credentials or configuration - structurally, not just by convention.

**Output**, explicitly distinguishing three kinds of information per this milestone's own
requirement:

```ts
{
  summary: string;              // derived
  callerIntent: string;         // derived
  keyFacts: string[];           // observed transcript facts
  actionItems: string[];        // derived
  followUpRequired: boolean;    // derived
  urgency: "low" | "medium" | "high";
  language: "en" | "fi" | "unknown";
  confidence: "high" | "medium" | "low";
  uncertain?: string[];         // explicitly-flagged unknown/uncertain information - never merged into keyFacts
}
```

## Registry resolution — proven to fail closed, not proven to work

`evals/voice-call-summary.test.ts` proves, against the **real, unmodified** registry and router
(not a mock):

- `routeCapability("voice.summarize", {})` → `NO_APPROVED_PROVIDER`
- `routeCapability("voice.summarize", { "voice-summary": voiceSummaryProvider })` → still
  `NO_APPROVED_PROVIDER` - the honest stub is present in `providerMap` and still isn't selected
- `routeCapability("voice.summarize", { "voice-summary": <a fully working deterministic provider> })`
  → **still** `NO_APPROVED_PROVIDER` - registry eligibility (`status`/`integration_state`), not
  `providerMap` membership, is what gates routing. A capability does not become production-routable
  merely because _something_ answers to its provider id.
- `runTask()` end-to-end (real orchestrator, real registry, real router) resolves a call-summary
  request to `CAPABILITY_UNAVAILABLE`, never `COMPLETE` - the orchestrator honestly reports the
  current true state rather than a caller having to know to check `providerMap` first.

## Structured execution: `runStructuredTask()`

`runTask()`'s generic provider-execution step only ever passes `{ capability, request: <free-text
string> }` to a provider (see `core/orchestrator.ts`) - there was no mechanism for a structured
payload like a transcript to flow through that generic interface. Rather than let that gap stand,
`core/orchestrator.ts` gained one small, provider-agnostic addition:

- **`runStructuredTask(taskId, { capability, input, context? }, deps)`** - the structured-input
  analog of `runTask()`, for a caller that already knows exactly which capability it wants and has
  a validated, Skill-specific payload for it (not free text to classify). It skips intent
  classification/planning (the capability is explicit, not inferred) but goes through **exactly**
  the same routing, permission, evidence, verification, and audit machinery as `runTask()`, via a
  shared internal `executeStep()` helper both entrypoints call. `runTask()`'s own behavior is
  byte-for-byte unchanged (its full existing test suite, including `permission-enforcement.test.ts`
  and `capability-routing.test.ts`, passes unmodified) - this was an addition, not a rewrite.
- **`OrchestratorDeps.registryOverrideForCapability`** - TEST-ONLY. Lets a deterministic test
  supply its own in-memory `RegistryEntry[]` for a specific capability instead of the real,
  committed registry, so the pipeline's mechanics can be proven end-to-end without making a
  `REVIEW`/`REFERENCE` capability routable in production. Left unset (the default for every real
  caller), `routeCapability()` behaves exactly as it always has. Same trust boundary as
  `providerMap` itself: both are supplied by first-party calling code, never by an external
  Skill/provider/agent, and neither ever touches `core/registry/data.ts`.

Neither change adds any Voice-specific logic to `core/router/index.ts` or `core/orchestrator.ts` -
both are generic primitives any future structured-input Skill can reuse.

## Two distinct kinds of test coverage - do not confuse them

`evals/voice-call-summary.test.ts` has two describe blocks that must not be conflated:

1. **"granular provider-level coverage"** - calls `provider.execute()` directly. Useful,
   fine-grained unit coverage of the provider's own logic (schema validation, malformed-output
   handling, thrown-error handling) - but **not** proof that the full orchestrator pipeline
   (routing → permission → evidence → verification → audit) works, since it bypasses all of that.
2. **"PHASE 7B: TRUE end-to-end pipeline via `runStructuredTask()`"** - the actual proof. Uses the
   real `routeCapability()`/`checkPermission()`/`EvidenceCollector`/`verify()`/`AuditLog` exactly as
   production code would, with only two things injected for the test: the deterministic provider
   (via `providerMap`) and a locally-constructed, never-committed "as if eligible" registry entry
   (via `registryOverrideForCapability`). This block proves:
   - `runStructuredTask()` fails closed for the capability's **real, unmodified** registry entry
     even with a working provider present in `providerMap` (the override is what changes the
     outcome, not a weaker default).
   - With the override, the full pipeline succeeds: input validated, capability resolved, `MEDIUM`
     risk classified and approved, the deterministic provider selected and executed with the
     validated structured input, its result schema-checked, evidence collected, verification
     resolved (`UNVERIFIED`, see below), and a complete audit trail emitted - with the raw
     transcript absent from the report and audit trail throughout, proven with a distinctive marker
     string.
   - Repeated execution of the identical structured task is deterministic.
   - A malformed provider response and an unwired/unknown provider id both fail closed rather than
     fabricating success.
   - Caller-supplied `provider`/`providerId`-shaped fields inside the structured input are never
     used to select a different provider - `routeCapability()` already chose the provider before
     the input was ever handed to `execute()`.

Both blocks also prove the transcript is treated as **data, never an instruction**: a transcript
containing genuine urgency language _and_ an injected literal claim trying to dictate
`urgency: "low"` still resolves to `urgency: "high"` - the algorithm wins (mirrors
`evals/untrusted-web-content.test.ts`'s existing pattern) - and that `keyFacts` can never contain
fabricated content: every fact is a literal substring of the transcript, since the deterministic
provider only ever extracts, never invents.

## Verification semantics

`verify({ evidence, providerOutcome })` on a fully successful run resolves to **`UNVERIFIED`,
never `VERIFIED`.** This is intentional, not a gap: `core/evidence/index.ts`'s
`STRONG_EVIDENCE_TYPES` has no category for AI-generated interpretive output (test/build/
ci_check/diff/database_query all describe objectively-checkable claims; "this summary is accurate"
is not one), so the architecture correctly refuses to claim confirmed accuracy for something it
cannot independently confirm - matching this product's own anti-sycophancy principle
(`docs/security-model.md`) applied to a new domain, not a shortfall to paper over.

## Production integration boundary (documented, not built)

**No production wiring was performed for this milestone.**
`src/app/api/v1/jobs/post-call/route.ts` is unmodified. This section documents what a future,
separately-authorized migration would look like - it is a plan, not a change.

**Current direct Anthropic call location**: `post-call/route.ts`, step "3. AI summary + sentiment"
(around the `routeModel("summary")` / `anthropic.messages.create()` call). The route imports
`anthropic` and `routeModel` directly and inlines the prompt and an `analysisSchema` Zod parse of
the raw model response - there is no Skill/registry/provider abstraction involved today.

**Current idempotency behavior that must be preserved:**

- The top-level `call.postCallProcessedAt` guard: once set, the entire job is a no-op on retry.
- The `!call.summary` guard specifically around the AI-summary step: a QStash retry whose earlier
  attempt already wrote a summary (and created the CRM `Activity`) must not re-run this step and
  create a duplicate `VOICE_AI_CALL` activity.
- The equivalent existence-check idioms for `usageRecord` (step 1) and `notification` (step 4).

Any future integration must preserve every one of these guards exactly - a Skill call substituting
for the inline Anthropic call does not change _when_ summarization should be attempted, only _how_.

**Current DB writes that must remain unchanged**: `voiceCall.update({ summary, sentiment,
actionsTaken })`, `activity.create()` (the CRM `VOICE_AI_CALL` activity), `notification.create()`,
the `usageRecord` insert, and the final `voiceCall.update({ postCallProcessedAt })`. None of these
are Skill concerns - they stay exactly as they are; only the _source_ of `summary`/`sentiment`/
`actionsTaken`'s values would change.

**What production wiring would replace or wrap:**

```
Voice call completed (webhook)
  → transcript available on the VoiceCall record (call.transcript)
  → root service builds a validated voice.summarize input:
      { transcript: <call.transcript, serialized>, callId: call.id,
        language: call.assistant.language === "FI" ? "fi" : "en" }
      (validated via callSummaryInputSchema before use - same as evals/voice-call-summary.test.ts)
  → Syveka Skill execution boundary:
      runStructuredTask(taskId, { capability: "voice.summarize", input }, deps)
      where deps.providerMap[<real-provider-id>] is a REAL Anthropic-calling provider
      (does not exist yet - see below) and the registry entry's status/integration_state
      have been deliberately promoted past REVIEW/REFERENCE only after that real
      provider is built and reviewed
  → structured, schema-validated CallSummaryOutput replaces today's inline
    analysisSchema.safeParse(...) result
  → existing persistence/post-call processing: the SAME voiceCall.update()/activity.create()
    calls as today, fed by the Skill's structured output instead of the inline parsed JSON -
    same idempotency guards, unchanged
```

**Can this migration be done independently in a follow-up PR?** Yes. Nothing about
`post-call/route.ts` depends on this Skill today (the registered provider is an unavailable stub;
the route doesn't reference `syveka-skills` at all), so building the real provider, promoting the
registry entry, and then swapping the route's inline Anthropic call for a `runStructuredTask()`
call are three separable, independently reviewable changes - not one large migration.

## What remains before this can move past REVIEW/REFERENCE

- A real provider implementation (an actual AI vendor call) - none exists in this Skill yet.
- A data-minimization review of exactly what transcript content would be sent externally, and to
  which vendor, before any live connection is built (per CLAUDE.md §7's "only send what a feature
  genuinely needs").
- If a live implementation is ever built, its prompt must live in a reviewable, versioned template
  - never hardcoded inline (CLAUDE.md §7) - this Skill has no prompt at all yet, since it has no
    LLM call at all yet.
- A deliberate decision on this Skill's relationship to the existing production pipeline (see
  above) - not assumed or decided by this document.
- `runStructuredTask()`'s `context` field is reserved but unused - no current caller populates it.
