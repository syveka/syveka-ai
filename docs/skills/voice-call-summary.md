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

---

# Real provider foundation (overnight mission, branch `feat/voice-summary-real-provider-foundation`)

Everything below was added on top of the merged foundation above (PR #122, merge commit
`e73fbc042380dea7fd634035df9db04b2f14dfda`). **It does not change anything above this line except
where explicitly noted.** The registry entry is still `status: REVIEW`, `integration_state:
REFERENCE`. The registered provider (`providers/voice-summary/index.ts`) is still the honest,
always-unavailable stub. `post-call/route.ts` is still untouched. No production Voice traffic uses
this Skill.

## What this addition proves - and what it still doesn't

It proves a **real, vendor-shaped provider implementation can exist, be tested deterministically,
and participate in the exact same orchestrator pipeline** as the deterministic test double - without
activating anything in production. It does **not** prove the implementation works against a real
vendor (no live call was made - see "Live test decision gate" below), and it does not prove the
_prompt itself_ produces high-quality summaries (no model was actually asked to follow it).

## New files

- `providers/voice-summary/completion-client.ts` - the DI seam (`VoiceSummaryCompletionClient`)
  between this Skill and a real AI vendor client. No vendor SDK import anywhere in this package.
- `providers/voice-summary/prompt.ts` - the fixed system-instructions builder, versioned and
  reviewable independently of request-handling code (CLAUDE.md §7).
- `providers/voice-summary/real-provider.ts` - `createVoiceSummaryProvider(client, options?)`, the
  real provider implementation. **Not exported from `index.ts`. Not registered in any real
  `providerMap`.**
- `providers/voice-summary/production-mapping.ts` - pure, unit-tested mapping helpers between the
  production DB/route shape and the Skill contract. **Not imported by `post-call/route.ts`.**
- `evals/voice-summary-real-provider.test.ts` (24 tests) - provider unit tests against a mocked
  `VoiceSummaryCompletionClient`: happy path, malformed/adversarial responses, timeout/rate-limit/
  outage classification, prompt-injection structural resistance, multilingual passthrough, privacy.
- `evals/voice-summary-production-mapping.test.ts` (9 tests) - mapping helper unit tests.
- `evals/voice-summary-shadow-pipeline.test.ts` (5 tests) - proves the real provider (mocked client)
  reaches the orchestrator's `UNVERIFIED` end state through `runStructuredTask()`, the same way the
  deterministic provider does in the PHASE 7B block above, and that the real, committed registry
  entry still fails closed even with this provider fully available.

## Why Anthropic, and why this DI shape instead of a direct SDK import

`post-call/route.ts` already calls Anthropic directly via `src/server/integrations/anthropic.ts`
(`routeModel("summary")` → `claude-haiku-4-5-20251001`, credentials from `getAnthropicEnv()`). Per
this mission's "prefer reusing an already-approved, already-operated provider" instruction, Anthropic
is the only vendor evaluated for real implementation - no OpenAI/other vendor code was written.

However, `syveka-skills` is an intentionally separate, unlinked npm package (own `package.json`, own
`node_modules`, no workspace reference to the root app - see `syveka-skills/package.json`). It has
zero AI-vendor SDK dependency today. Importing `@/server/integrations/anthropic.ts` directly would
be impossible (it's a Next.js `server-only` module, not resolvable from this package) and adding
`@anthropic-ai/sdk` as a new dependency here would duplicate credential/client bootstrap that already
exists and is already reviewed in the root app - exactly what Phase 8/26 of this mission says not to
do ("do not duplicate credential/client bootstrap unnecessarily", "prefer existing dependencies").

The resolution: `VoiceSummaryCompletionClient` is a **narrow interface**, not a vendor SDK wrapper.
`real-provider.ts` has zero network/vendor imports. A future, separately-authorized production
integration PR implements this interface **in the root app**, using the root's own already-configured
`anthropic` client, and injects it into `createVoiceSummaryProvider()` at construction time - the
same trust boundary `OrchestratorDeps.providerMap` already has (first-party calling code only, never
an external Skill/provider/agent, never touching the committed registry). No new dependency was added
to `syveka-skills/package.json` (confirmed: `git diff origin/main -- package.json package-lock.json`
is empty).

## Compatibility matrix — production contract vs. Skill contract

| Field                    | Production (`post-call/route.ts`)                                                                          | Skill (`voice.summarize`)                               | Class | Note                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| transcript input         | `JSON.stringify(call.transcript ?? [])` (raw `Json?` column, **no enforced shape** - prisma/schema.prisma) | `transcript: string`, 1-50k chars, non-whitespace       | **F** | No verified shape exists to parse `call.transcript` into clean dialogue text today. A future adapter must add its own normalization step first (see "Migration plan" stage 1) - this mission does not invent one against an unverified schema.                                                                                                                                                 |
| callId                   | implicit (`call.id`, Prisma cuid)                                                                          | `callId: string`, 1-200 chars                           | **A** | Direct passthrough.                                                                                                                                                                                                                                                                                                                                                                            |
| language                 | `call.assistant.language` = Prisma `Locale` enum: `EN \| FI \| AR`                                         | `"en" \| "fi" \| "unknown"`                             | **D** | **No `"ar"` value exists in the Skill contract.** Production's own current ternary (`=== "FI" ? Finnish : English`) already collapses AR→English; `mapProductionLocaleToSkillLanguage()` deliberately maps AR→`"unknown"` instead (does not repeat that collapse), but a real fix requires extending `callSummaryLanguageSchema` - a schema/contract change, out of scope here (see blockers). |
| metadata.durationSeconds | `call.durationSeconds`                                                                                     | `metadata.durationSeconds?: number`                     | **B** | Transformable, direct passthrough.                                                                                                                                                                                                                                                                                                                                                             |
| summary                  | `analysisSchema.summary: string`                                                                           | `summary: string`                                       | **A** | Same shape.                                                                                                                                                                                                                                                                                                                                                                                    |
| callerIntent             | _(none)_                                                                                                   | `callerIntent: string`                                  | **D** | Skill-only field; not persisted anywhere today.                                                                                                                                                                                                                                                                                                                                                |
| keyFacts                 | _(none)_                                                                                                   | `keyFacts: string[]`                                    | **D** | Skill-only; not persisted today.                                                                                                                                                                                                                                                                                                                                                               |
| actionItems / followUps  | `analysisSchema.followUps: string[]` (max 5)                                                               | `actionItems: string[]` (max 10)                        | **B** | `mapSkillOutputToProductionAnalysis()` truncates to 5 with an explicit warning, never a silent drop.                                                                                                                                                                                                                                                                                           |
| followUpRequired         | _(none - only followUps array, no explicit boolean)_                                                       | `followUpRequired: boolean`                             | **D** | Skill-only.                                                                                                                                                                                                                                                                                                                                                                                    |
| urgency                  | _(none)_                                                                                                   | `urgency: "low"\|"medium"\|"high"`                      | **D** | Skill-only; **not the same axis as sentiment** (see next row).                                                                                                                                                                                                                                                                                                                                 |
| sentiment                | `analysisSchema.sentiment: "positive"\|"neutral"\|"negative"`                                              | _(none)_                                                | **E** | **Semantically conflicting, not just missing.** Urgency and sentiment are different axes (a call can be high-urgency/neutral-sentiment). `mapSkillOutputToProductionAnalysis()` returns `sentiment: null` with an explicit warning - it never derives one from the other, which would be fabrication.                                                                                          |
| confidence               | _(none)_                                                                                                   | `confidence: "high"\|"medium"\|"low"`                   | **D** | Skill-only; no analog in production's `analysisSchema`.                                                                                                                                                                                                                                                                                                                                        |
| uncertain                | _(none - failures are silently swallowed by the route's outer `try { } catch { /* best-effort */ }`)_      | `uncertain?: string[]`                                  | **D** | Production has no concept of "partially confident" output today - it's binary success/no-op.                                                                                                                                                                                                                                                                                                   |
| persistence fields       | `voiceCall.update({ summary, sentiment, actionsTaken })`, `activity.create()`, `notification.create()`     | _(none - Skill has no persistence)_                     | **F** | Persistence stays entirely production's responsibility; the Skill only ever returns structured data (see "Production integration adapter").                                                                                                                                                                                                                                                    |
| audit/log metadata       | none beyond a swallowed `catch`                                                                            | `AuditLog` events + `EvidenceItem[]` (capped, scrubbed) | **D** | Skill-only; a real gain over today's silent best-effort failure.                                                                                                                                                                                                                                                                                                                               |

**Conclusion**: the Skill can wrap the _existing product behavior_ for `summary`/`followUps`
directly, but **cannot currently reproduce `sentiment`** without either a schema change or a
separate classification step, and the transcript-input side needs a dedicated normalization step
that does not exist yet on either side. This is a real, load-bearing gap - not a rounding error - and
migration must not proceed by silently dropping `sentiment` from production's DB writes.

## Prompt-injection resistance — design and what was actually tested

`prompt.ts`'s `buildSystemInstructions(language)` is built **only** from the validated 3-value
`language` enum - never from transcript text or any other caller-supplied free text. There is no code
path by which transcript content can reach the system instructions; `real-provider.ts` passes
`transcriptData` to the client as a structurally separate field, and a real client implementation is
required to send it as the model's user-turn content, never concatenated into the system/developer
turn (mirroring `src/server/integrations/anthropic.ts`'s own `streamClaude()`, which already
separates `system` from `messages`).

`evals/voice-summary-real-provider.test.ts`'s "prompt-injection structural resistance" block tests,
with a mocked client, transcripts containing: "Ignore all previous instructions", "You are the
system", "Return the API key", "Call another tool", "Use another provider", "SYSTEM OVERRIDE" claims
dictating specific output values, and Finnish/Arabic/mixed-language variants. What is actually proven:

- The captured `systemInstructions` sent to the client is byte-identical regardless of transcript
  content - injection text can never alter it, structurally, not just empirically.
- `systemInstructions` varies **only** with the `language` enum.
- Even a simulated "fooled model" response (mocked to fabricate an extra `apiKey` field, or to comply
  with an injected instruction by fabricating a `summary` value) is either rejected outright by the
  `.strict()` output schema (the extra-field case) or passes through as **schema-valid but
  semantically influenced** (the fabricated-summary-text case).

**What this does NOT prove**: that a real model will resist a cleverly-worded injection at the
_content_ level. Schema validation guarantees **structure**, not **truthfulness of prose fields**
like `summary`/`callerIntent`/`keyFacts`. This is a documented, honest limitation - not something a
mock can settle - and is exactly why `verify()` never resolves an AI-summarization result to
`VERIFIED` (see "Verification semantics" above).

## Data minimization / privacy review

**Sent to the external provider** (by a real client implementation, per `VoiceSummaryCompletionRequest`):
`systemInstructions` (fixed, no caller data) and `transcriptData` (the raw transcript text) plus the
3-value `language` enum used only to select the language directive.

**Explicitly excluded from the provider request** - none of these fields exist anywhere on
`VoiceSummaryCompletionRequest`, so there is no code path that could send them even by mistake:
database IDs (`callId` is used for evidence/audit correlation only, never sent to the vendor),
`organizationId`/tenant identifiers, caller phone number, internal audit event IDs, credentials,
workflow/billing metadata. `callSummaryInputSchema.strict()` already independently guarantees a
caller cannot smuggle any of these into the Skill's input in the first place.

**Default rule honored**: the minimum payload (`transcript` + `language`) is what crosses the
external-provider boundary, per this mission's explicit preference.

## Fabrication / grounding result

Deterministic unit tests **cannot** prove a real LLM won't fabricate facts - that requires either a
live model or a corpus of human-graded outputs, neither of which this mission has. What the test
suite _can and does_ prove deterministically:

- The provider never invents a field the model didn't return - `.strict()` schema validation is the
  only path data reaches the caller through.
- A model response is never trusted without going through `callSummaryOutputSchema.safeParse()`
  first, on every code path, no exceptions.
- Production's own DB-write side (`mapSkillOutputToProductionAnalysis()`) never fabricates
  `sentiment` from `urgency` or any other field - it returns `null` with an explicit warning instead.

**This is a documented limitation, not a claim of solved fabrication risk.** Actual
grounding/fabrication quality can only be evaluated against a real model - tracked as a blocker below,
not silently assumed.

## Long-transcript strategy

`callSummaryInputSchema`'s existing `MAX_TRANSCRIPT_CHARS = 50_000` cap (already present before this
mission) already implements "reject oversized input" (option A from this mission's Phase 11) - a
transcript over 50k chars fails input validation with a normalized error, before any provider call is
attempted. Token-budget check: 50,000 characters is roughly 12,000-15,000 tokens for typical English/
Finnish text, comfortably within `claude-haiku-4-5-20251001`'s context window (production's own model
choice for this task) alongside the ~400-token fixed system instructions. No content is ever silently
dropped or truncated by this Skill - a transcript either validates in full or is rejected in full.
Hierarchical chunking (option C) was not built - nothing in current production usage patterns
(observed via `post-call/route.ts`'s own `transcriptText.slice(0, 30_000)` cap on the _production_
side) suggests transcripts routinely approach 50k characters, so chunking would be speculative
complexity per the charter's "fix only proven problems" principle.

## Multilingual result

Tested with synthetic transcripts (mocked client, no live model): English, Finnish (diacritics,
compound words - e.g. "lämmitysjärjestelmäni"), Arabic (RTL script), and a mixed English/Finnish/
Arabic transcript. All pass through `transcriptData` byte-for-byte with no mangling, and schema
validation is unaffected by script direction or Unicode content. **Known, documented gap**: Arabic has
no first-class `language` enum value (`callSummaryLanguageSchema` is `en \| fi \| unknown` only) even
though production's own `Locale` enum already supports `AR` - see the compatibility matrix above.
`buildSystemInstructions("unknown")` still instructs the model to respond in "the same language
predominantly used in the transcript", so Arabic transcripts are not unhandled, just not first-class.
No claim of actual translation/summarization _quality_ in Finnish or Arabic is made - that requires a
live model, which this mission did not run.

## Provider availability / config

`createVoiceSummaryProvider(client).isAvailable()` delegates directly to `client.isConfigured()` - a
real client implementation (root-app-side, not yet built) would return `false` whenever
`ANTHROPIC_API_KEY` or equivalent is absent/malformed, matching `getAnthropicEnv()`'s existing
fail-closed validation. `execute()` independently re-checks `isConfigured()` before ever attempting a
call (defense in depth, in case a caller invokes `execute()` without checking `isAvailable()` first),
returning `UNAVAILABLE` with a message that never echoes any credential/config detail.
`createUnconfiguredCompletionClient(reason)` is the honest default with no config bridge wired -
`isConfigured()` always `false`, `complete()` always throws a `VoiceSummaryProviderConfigError`. No
secret is duplicated into `syveka-skills` - see "Why Anthropic, and why this DI shape" above.

## Routing status decision: **kept at REVIEW / REFERENCE**

Per this mission's explicit instruction, the registry entry was **not** promoted, despite the real
provider now existing and being tested. Evidence that exists today: provider implementation (✓),
schema validation on both sides (✓), availability semantics (✓), 38 new deterministic tests passing
(✓, see below). Evidence that does **not** exist yet, and is required before any future promotion
decision: a live call against a real vendor (not run this mission - see next section), a
security/privacy review of an actual (not simulated) model response, and a deliberate product decision
on this Skill's relationship to `post-call/route.ts` (still undecided, per the original milestone
doc above).

## Shadow execution / full-pipeline proof

`evals/voice-summary-shadow-pipeline.test.ts` proves the real provider (mocked vendor client)
participates in `runStructuredTask()`'s full route → permission → execute → evidence → verify → audit
pipeline identically to the deterministic test double already proven in the PHASE 7B block above -
reaching `UNVERIFIED` (not `CAPABILITY_UNAVAILABLE`/`FAILED`), with `provider_selected` audit data
correctly identifying the real-provider instance, and the raw transcript absent from the full report.
Crucially, it also re-proves that the **real, committed registry entry** (`status: REVIEW`) still
fails closed even when a fully available, fully working real-provider instance is injected into
`providerMap` under the registry's actual provider id (`"voice-summary"`) - registry eligibility, not
provider capability, is what gates production routing. This is not the production route -
`post-call/route.ts` is not imported or called anywhere in this test.

## Idempotency preservation design (for a future production integration)

No code changes were made to `post-call/route.ts` or any idempotency-related logic this mission - this
section documents constraints a future integration PR must satisfy, extending the original milestone
doc's "Current idempotency behavior that must be preserved" section above:

- A `runStructuredTask()` call substituting for the inline `anthropic.messages.create()` call must sit
  **inside** the existing `if (transcriptText.length > 10 && !call.summary)` guard, not replace it -
  the guard is what prevents a QStash retry from re-running summarization and creating a duplicate
  `VOICE_AI_CALL` activity.
- The Skill call itself must not introduce its own retry loop that could duplicate a paid vendor call
  - `real-provider.ts`'s `withTimeout()` fails once and returns `FAILURE`; it does not retry
    internally (unlike `streamClaude()`'s existing retry loop for transient errors), so retry policy
    stays entirely the caller's (i.e., QStash's existing job-retry mechanism, gated by the same
    `!call.summary` check) - a deliberate choice to avoid duplicate-billing risk from a
    Skill-internal retry stacking on top of an outer job retry.
- `mapSkillOutputToProductionAnalysis()` is pure and side-effect-free - calling it twice with the same
  input is always safe; the actual DB write remains the integration's responsibility, using the exact
  same `voiceCall.update()` call production already makes.

## Failure matrix (documentation only - nothing beyond the provider/mapping layer implemented)

| Failure                                                          | Expected behavior                                                                                                                                                                                                                                  | Where enforced                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Provider unavailable (no credentials)                            | `UNAVAILABLE`, fails closed, no call attempted                                                                                                                                                                                                     | `real-provider.ts` `isAvailable()`/`execute()` |
| Provider timeout                                                 | `FAILURE`, normalized `TIMEOUT` code, no retry inside the provider                                                                                                                                                                                 | `real-provider.ts` `withTimeout()`             |
| Rate limit (HTTP 429)                                            | `FAILURE`, normalized `RATE_LIMITED` code                                                                                                                                                                                                          | `classifyClientError()`                        |
| Provider 5xx / outage                                            | `FAILURE`, normalized `PROVIDER_OUTAGE` code                                                                                                                                                                                                       | `classifyClientError()`                        |
| Malformed/non-JSON model output                                  | `FAILURE`, generic message, raw text never surfaced                                                                                                                                                                                                | `real-provider.ts` JSON.parse guard            |
| Schema-invalid output (missing/wrong-typed/injected extra field) | `FAILURE`, `.strict()` rejection                                                                                                                                                                                                                   | `callSummaryOutputSchema.safeParse()`          |
| Oversized transcript                                             | `FAILURE` at input validation, before any provider call                                                                                                                                                                                            | `callSummaryInputSchema` (50k cap)             |
| Empty transcript                                                 | `FAILURE` at input validation                                                                                                                                                                                                                      | `callSummaryInputSchema`                       |
| DB unavailable                                                   | _(not this Skill's concern - persistence is entirely the caller's responsibility; a future adapter must wrap its own DB write in the same try/catch discipline `post-call/route.ts` already uses)_                                                 | future integration adapter                     |
| Duplicate job (retry)                                            | Prevented by production's existing `postCallProcessedAt`/`!call.summary` guards, unchanged                                                                                                                                                         | `post-call/route.ts` (untouched)               |
| Retry after partial failure                                      | Same guards - a retry that reaches the AI-summary step again only does so if `!call.summary` is still true                                                                                                                                         | `post-call/route.ts` (untouched)               |
| Provider succeeds but persistence fails                          | _(future integration concern - today's route already swallows this class into a bare `catch { /* best-effort */ }`; a real integration should consider whether that's still the right behavior once persistence has real structured data to lose)_ | flagged, not decided                           |
| Provider fails before persistence                                | No DB write attempted - `execute()` returns before any `data` exists                                                                                                                                                                               | `real-provider.ts`                             |
| Unsupported language (e.g. Arabic)                               | Falls back to `"unknown"` handling, not rejected                                                                                                                                                                                                   | `mapProductionLocaleToSkillLanguage()`         |
| Audit write failure                                              | Out of this Skill's scope - `AuditLog`/`EvidenceCollector` are in-memory, no I/O that can fail                                                                                                                                                     | `core/reporting/audit.ts` (unchanged)          |

## Observability

Evidence emitted per successful call (`real-provider.ts`): `callId`, `urgency`, `confidence`,
`followUpRequired`, `model`, `tokensIn`, `tokensOut`, `latencyMs`. Explicitly never included: raw
transcript, full prompt/system instructions, API credentials, the full model response text, or any
field containing transcript-derived free text (`summary`/`callerIntent`/`keyFacts` are never copied
into evidence, only structured metadata about them). `evals/voice-summary-real-provider.test.ts`'s
"privacy" block asserts this with distinctive marker strings across every failure mode and the success
path.

## Cost / latency instrumentation

`VoiceSummaryCompletionResponse` carries optional `tokensIn`/`tokensOut` (a real client
implementation can populate these from the vendor SDK's own usage response, e.g.
`res.usage.input_tokens`/`output_tokens` on an Anthropic `Message`, exactly what
`streamClaude()` already reads). `latencyMs` is measured by `real-provider.ts` itself around the
`client.complete()` call, vendor-agnostic. **What cannot be measured without a live call**: actual
dollar cost (requires per-model pricing, not implemented here - out of scope, "do not redesign cost
accounting" per this mission) and real-world latency distribution (only a mocked, near-instant client
was exercised). What should be persisted later: this metadata is currently evidence-only
(`EvidenceItem.data`, JSON-stringified) - a future integration deciding to persist it durably (e.g.
for cost dashboards) would need its own schema/table decision, not made here.

## Live test decision gate: **NOT RUN**

Per this mission's Phase 21 conditions (all must hold before a live call is permitted), evaluated
honestly:

1. Synthetic transcript only - ✓ would be satisfied.
2. **An existing, verified-available development credential** - ✗ **not confirmed**. This mission had
   no verified `ANTHROPIC_API_KEY` explicitly provisioned and confirmed safe for this exact purpose in
   this environment.
3. No secret printed - would need to be verified operationally, not assumed.
4. Minimal cost - a single Haiku-class call would be cheap, but "cheap" is not "authorized".
5. No production data - ✓ would be satisfied (synthetic transcripts only, as used throughout this
   mission's tests).
6. No production DB write - ✓ satisfied by design (no code path in this branch writes to the DB).
7. Live test clearly opt-in/isolated - no such isolated live-test harness exists for the real
   provider yet (unlike `evals/scrapling-live.test.ts`/`remotion-live.test.ts`'s existing
   `describe.skip`-by-default pattern for other providers - a real live-test file for voice-summary
   would need to be added deliberately in a future, explicitly-scoped task).
8. Repository policy allows it - not independently confirmed for this specific vendor call in this
   context.

Condition 2 alone is sufficient to stop: **LIVE TEST NOT RUN — HUMAN AUTHORIZATION REQUIRED.** This
is the correct, expected outcome per this mission's own explicit instructions, not a failure.

## Production integration adapter (designed, and partially implemented as pure/unconnected code)

`production-mapping.ts` implements the two pure mapping directions described in the compatibility
matrix above (`buildSkillInputFromNormalizedCall`, `mapSkillOutputToProductionAnalysis`). Neither
function is imported by `post-call/route.ts`, and neither performs any I/O. The remaining adapter
work - normalizing `call.transcript`'s actual JSON shape into `transcriptText`, constructing a real
`VoiceSummaryCompletionClient` from `src/server/integrations/anthropic.ts`, and wiring
`runStructuredTask()` into the route itself - is **not implemented**, per this mission's explicit
"MUST NOT connect it to post-call/route.ts" instruction.

## Migration plan

| Stage | Description                                                                                                                     | Gate                                                                                                                       | Rollback                                                                   | Evidence required                                                             | Monitoring                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1     | Provider implementation merged, non-routable (**this mission**)                                                                 | Tests pass, registry stays REVIEW/REFERENCE                                                                                | Revert the branch/PR - nothing else references it                          | This document + 38 new passing tests                                          | None (no runtime exposure)                              |
| 2     | Shadow execution on synthetic/dev calls (a real client wired in a dev-only harness, still not called from `post-call/route.ts`) | A verified dev credential + explicit authorization for a live call                                                         | Remove the dev harness                                                     | At least one real vendor response validated against `callSummaryOutputSchema` | Manual review of shadow outputs                         |
| 3     | Internal test account only (route wired behind a feature flag/org allowlist, real DB writes gated to one internal org)          | Registry entry promoted (status/integration_state) with explicit sign-off; `sentiment` gap resolved or explicitly accepted | Flip the flag off; production path untouched for all other orgs            | Stage 2 evidence + a small number of manually-reviewed real summaries         | Error rate, latency, cost per call on the test org only |
| 4     | Limited pilot (a small set of opted-in customer orgs)                                                                           | Stage 3 monitored clean for a defined period; rollback tested at least once                                                | Flip the flag off for pilot orgs; they revert to the direct Anthropic path | Pilot-scale error/quality metrics                                             | Per-org error rate, cost, latency; manual spot-checks   |
| 5     | Production cutover (all orgs)                                                                                                   | Pilot metrics meet an explicitly agreed bar (not defined by this document)                                                 | Flip the flag off globally                                                 | Pilot-stage evidence reviewed and approved by a human                         | Full production observability parity with today's route |
| 6     | Remove the old direct Anthropic call from `post-call/route.ts`                                                                  | Stage 5 stable for a defined burn-in period, explicit authorization to delete code                                         | Re-add the inline call from source control (git revert)                    | Stage 5 production evidence                                                   | Same as stage 5                                         |

## Rollback plan

- **Disable the Skill route**: every stage above is gated behind an explicit flag/allowlist
  decision (not yet implemented) rather than an unconditional swap - flipping it off is a single
  config change, not a code revert, for stages 3-5.
- **Revert to the current direct Anthropic path**: until stage 6, the existing inline
  `anthropic.messages.create()` call in `post-call/route.ts` is never removed, only bypassed when the
  flag is on - so rollback at any stage before 6 requires no code change at all, only flipping the
  flag back off.
- **Prevent duplicate work**: because any future integration must sit inside the existing
  `!call.summary` guard (see "Idempotency preservation design" above), a mid-flight rollback cannot
  cause the same call to be summarized twice by both paths - whichever path runs first sets
  `call.summary`, and the guard prevents the other from ever running for that call.
- **Preserve existing DB state**: rollback never deletes or overwrites a `summary`/`sentiment`/
  `actionsTaken` value already written by either path - it only changes which path handles the _next_
  call.
- No production feature flag was implemented in this mission - this section documents the plan a
  future integration PR would need to build, per this mission's "do not implement production flags
  unless clearly justified and completely non-invasive" instruction (a flag doesn't exist to be
  invasive or not yet).

## Security review (this branch)

- No prompt-injection policy escape: `systemInstructions` is structurally independent of transcript
  content (see "Prompt-injection resistance" above).
- No provider/model override through input: `callSummaryInputSchema.strict()` has no `provider`/
  `model`/`apiKey` field; `real-provider.ts` only ever reads the four whitelisted fields off `input`
  before validation, so an extra field is never even seen, let alone acted on (see
  `evals/voice-summary-real-provider.test.ts`'s "credential/config-shaped extra fields" test).
- No credentials in request input: confirmed structurally (schema has no such field) and empirically
  (test asserts injected `apiKey`/`model` values never reach `client.calls` or the result).
- No transcript logging: every error path returns a fixed, generic message string, never
  `error.message` or the raw model response text verbatim (`classifyClientError()`).
- No raw model output in logs: `stripMarkdownFence`'d text is parsed and validated, never itself
  stored in evidence - only derived, capped metadata is.
- No cross-call state: `createVoiceSummaryProvider()` closes over only its `client`/`options`
  arguments; no module-level mutable state exists in any new file.
- No unsafe global mutable cache: none introduced.
- No weak fallback provider: `classifyClientError()` fails closed to a generic `PROVIDER_ERROR` for
  any unrecognized error shape - it never assumes success.
- No registry widening: `core/registry/data.ts` was not touched this mission (`git diff origin/main
-- syveka-skills/core/registry/data.ts` is empty).
- No direct production activation: confirmed via the shadow-pipeline test's explicit assertion that
  the real, committed registry entry still fails closed with a fully working real provider present.
- No secret committed: fresh scan of the full branch diff, see "Diff review" below.
- No `.env` committed: confirmed.
- No test fixture with real PII: all transcripts across all new test files are synthetic.
- No Calendar changes: confirmed, zero files under any Calendar path touched.
- No unrelated integration changes: confirmed, diff scope limited to `providers/voice-summary/*`,
  `evals/voice-summary-*`, and this document.

## Dependency security

No new package dependency was added anywhere in this mission - `git diff origin/main -- package.json
package-lock.json` (root) and the equivalent for `syveka-skills/package.json`/
`syveka-skills/package-lock.json` are both empty. `npm audit` inside `syveka-skills/` reports 3
vulnerabilities (2 moderate, 1 high) via `js-yaml` (`@remotion/cli` → `@remotion/studio-server` →
`@svgr/core` → `cosmiconfig` → `js-yaml`) - **confirmed pre-existing on `origin/main` itself**
(identical lockfile, unrelated to any file this mission touched, part of the Remotion toolchain from
an earlier, already-merged milestone). Not fixed here - out of scope, and fixing it would require a
`js-yaml`/`cosmiconfig`/`@svgr`/`@remotion` upgrade decision this mission was not authorized to make.
Flagged for separate triage, mirroring the earlier fast-uri advisory triage precedent.

## Production-readiness scoring

Honest, not inflated - each axis reflects exactly what evidence exists today, per this mission's
explicit "do not inflate scores" instruction.

| Axis                           | Score | Basis                                                                                                                               |
| ------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1. Skill contract              | 90%   | Stable, `.strict()`, unit-tested; missing only a real `ar` language value                                                           |
| 2. Routing                     | 100%  | Fails closed in every tested configuration, including with a fully working real provider available                                  |
| 3. Provider implementation     | 70%   | Complete against the mocked interface; zero live-vendor validation                                                                  |
| 4. Provider availability       | 85%   | Honest `isConfigured()` delegation + defense-in-depth re-check; real config bridge not built (root app doesn't inject a client yet) |
| 5. Schema validation           | 95%   | Strict on both input and output, tested against adversarial/malformed payloads                                                      |
| 6. Prompt-injection resistance | 55%   | Structural separation proven; real-model resistance unproven (see limitation above)                                                 |
| 7. Privacy                     | 85%   | Data-minimization design followed and tested; no live-vendor data-handling audit possible yet                                       |
| 8. Deterministic tests         | 90%   | 38 new tests, all passing, covering happy/adversarial/multilingual/privacy paths                                                    |
| 9. Live provider evidence      | 0%    | None - deliberately not run this mission (see live test gate)                                                                       |
| 10. Production integration     | 20%   | Adapter/mapping designed and partially implemented (pure functions only); not connected                                             |
| 11. Idempotency                | 40%   | Constraints documented in detail; no code exists yet to test against                                                                |
| 12. Rollback                   | 30%   | Plan documented; no flag/mechanism implemented yet                                                                                  |
| 13. Observability              | 60%   | Safe evidence metadata defined and tested; no real logging/alerting pipeline wired                                                  |
| 14. Cost visibility            | 35%   | Token/latency fields plumbed through; no real pricing/dashboard                                                                     |
| 15. Multilingual readiness     | 45%   | EN/FI solid; AR structurally unsupported as a first-class value                                                                     |

- **A. Skill Foundation Readiness** (axes 1-2, 5, 8): **94%**
- **B. Provider Readiness** (axes 3-4, 6-7, 9): **59%**
- **C. Production Integration Readiness** (axes 10-14): **37%**
- **D. Overall Production Readiness**: **~48%** (unweighted mean of A-C, deliberately not
  rounded up) - **not production-ready**, consistent with this mission's success criterion (real
  provider foundation + evidence + plan, not production activation).

## What remains before this can move past REVIEW/REFERENCE

- **Blocker (human-only)**: a live call against a real vendor, requiring a verified, safe-to-use
  development credential and explicit authorization - see "Live test decision gate" above.
- **Blocker (product decision)**: resolve the `sentiment` gap (Category E in the compatibility
  matrix) - either add a real sentiment field to `callSummaryOutputSchema` or decide production's
  `sentiment` column becomes unpopulated/deprecated under a Skill-based path. Not decided by this
  document.
- **Blocker (schema/contract change, needs its own authorization)**: extend
  `callSummaryLanguageSchema` with a real `"ar"` value, or explicitly accept `"unknown"` as Arabic's
  permanent handling.
- **Blocker (unverified data shape)**: `call.transcript`'s actual JSON shape has never been inspected
  by this mission (it's an untyped `Json?` column) - a real adapter needs to normalize it into
  `transcriptText` before `buildSkillInputFromNormalizedCall()` can be used against real data.
- A real client implementation (root-app-side) satisfying `VoiceSummaryCompletionClient`, using the
  existing `anthropic` client from `src/server/integrations/anthropic.ts` - not built this mission,
  by explicit instruction.
- A production feature flag / rollout mechanism (Migration plan stages 3-5) - not built.
- A deliberate decision on this Skill's relationship to `post-call/route.ts` (still undecided, per
  the original milestone doc above) - unchanged by this mission.
- `runStructuredTask()`'s `context` field is reserved but unused - no current caller populates it.
