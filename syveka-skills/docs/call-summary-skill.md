# voice-pilot/call-summary — Skill Reference

The first production-shaped Skill built end-to-end on the Syveka Master Skill architecture
(`docs/architecture.md`), added to prove the platform works for a real, structured, tenant-scoped
capability - not just for engineering-agent tasks (bug fix, UI search, skill discovery). This
document is the concrete `Skill -> Contract -> Policy -> Runtime -> Provider/Adapter -> Evaluation
-> Audit` walkthrough for it.

## What it does

Accepts a structured call/transcript payload and returns a structured call summary: `summary`,
`caller_intent`, `key_points`, `action_items`, `follow_up_required`, `risk_flags`, `language`,
`confidence`. Nothing more, nothing less - see "Contract" below.

## Skill

- Capability id: `voice.call_summary` (routing key - see `core/registry/data.ts`)
- Registry id: `voice-pilot-call-summary`
- Skill id (in execution metadata): `voice-pilot/call-summary`, version `1.0.0`

## Contract (`schemas/call-summary.ts`)

- `callSummaryInputSchema` (strict, no unsupported fields): `tenant_id` (required, non-empty -
  must come from a server-verified session/tenant context, never from the transcript body),
  `call_id`, `transcript` (1-500 turns, each turn capped at 4000 chars), optional advisory
  `language_hint`.
- `callSummaryOutputSchema` (strict): exactly the 8 fields the brief requires, typed and bounded
  (`risk_flags` is a closed enum, `confidence` is `0..1`, arrays are length-capped).
- A provider's raw output is only ever treated as a result after it round-trips through
  `callSummaryOutputSchema.parse()` - "the algorithm ran" is never conflated with "the contract
  was satisfied" (see `evals/call-summary.test.ts` "contract validation").

## Policy (`policies/risk-classification.ts`)

`voice.call_summary.execute` is classified **MEDIUM** risk, gated by
`core/permissions/index.ts`'s default (HIGH and MEDIUM both require human approval in this MVP).
This is deliberately MEDIUM despite the provider being first-party/local/no-network: the _input_
is real customer conversation content that may carry PII, which is a data-sensitivity risk
independent of the provider's own footprint - see `core/registry/data.ts`'s entry for the
footprint-vs-action-risk distinction this mirrors from Scrapling/Remotion.

## Runtime (`core/orchestrator.ts`)

Runs through the exact same `runTask()` loop as every other capability - classify intent → build
plan → route capability → check permission → execute provider → collect evidence → verify →
report. The only runtime change this Skill required was additive: `OrchestratorDeps` gained an
optional `context: Record<string, unknown>` field, passed through verbatim to
`provider.execute()`, because this Skill needs more than the free-text `request` string
(`classifyIntent()` still only reads `request`; the structured transcript/tenant payload rides in
`context`). No existing capability's behavior changed - `context` defaults to `undefined` and
every other provider ignores it.

## Provider/Adapter (`providers/call-summary/`)

- `index.ts` — the reference provider: real, deterministic, offline heuristic analysis
  (`heuristics.ts`: language detection, risk-flag pattern matching, intent classification,
  key-point/action-item extraction, confidence scoring). No network access, no third-party API,
  no credentials.
- `mock-provider.ts` — a second, structurally different implementation of the same `Provider`
  interface and the same contract, used only by
  `evals/call-summary-provider-portability.test.ts` to prove capability #6 of the platform-proof
  brief without integrating a new paid API.

**Why the reference provider is deterministic, not Claude-backed:** the Skill itself must not
depend on Claude-specific APIs (per the brief), and this codebase's model-agnostic boundary is
`Provider` - a real, testable, no-cost, no-credential implementation proves the architecture (schema
validation, tenant enforcement, evidence, audit) exercises real logic end-to-end without a live
LLM call in the loop, mirroring how `local-test-runner`/`git-diff` are this codebase's reference
"real" providers rather than stubs. **How to add a second (e.g. LLM-backed) provider**: write a
new file under `providers/call-summary/` implementing the same `Provider` interface - `isAvailable()`
reflecting real connectivity, `execute()` validating input against `callSummaryInputSchema` and its
own output against `callSummaryOutputSchema` before returning `SUCCESS` - then either replace the
`providerMap["voice-pilot-call-summary"]` entry (single active provider) or add a second registry
entry under the same `voice.call_summary` capability (the router picks by `trust_level`, highest
first - see `core/router/index.ts`). No change to `core/`, `schemas/call-summary.ts`, or this
provider's own code is required, exactly as `mock-provider.ts` already demonstrates.

## Evaluation (`evals/call-summary*.test.ts`)

- `evals/call-summary.test.ts` — contract validation, normal cases (short/long call, Finnish/
  English/Arabic/mixed-language, no-action/several-action-items), and adversarial cases (prompt
  injection, fake system instructions, malformed/empty/huge/unsupported-field payloads,
  cross-tenant identifiers, sensitive information, invalid model output), plus end-to-end
  orchestrator paths (COMPLETE/VERIFIED, BLOCKED without approval, CAPABILITY_UNAVAILABLE with no
  provider wired, FAILED on missing tenant context).
- `evals/call-summary-tenant-isolation.test.ts` — tenant A vs. tenant B scoping, fail-closed on
  missing/empty tenant context, and proof that audit/evidence never carry raw transcript content.
- `evals/call-summary-provider-portability.test.ts` — the reference and mock providers both
  satisfy the same contract end-to-end with no core/schema change between them.

Run: `npm test` (from `syveka-skills/`) or `npm run demo:call-summary` for the narrated demo.

## Audit

Every execution produces `CallSummaryExecutionMeta` (`schemas/call-summary.ts`): skill id/version,
`tenant_ref`, provider id, `started_at`/`ended_at`/`duration_ms`, `status`, and
`error_classification`. This is kept structurally separate from the 8-field output contract and
from `core/reporting/audit.ts`'s generic `AuditEvent`s, and deliberately excludes transcript
content, caller-identifying details, or any secret - see `evals/call-summary-tenant-isolation.test.ts`
"audit/evidence does not store raw transcript content" for the mechanical proof, not just this
paragraph's claim.

## Security summary

| Requirement (task brief §4)                                 | How it's enforced                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant A cannot access tenant B data                        | Provider is stateless; `tenant_ref` in every result traces only to that call's own `tenant_id` input                                      |
| Missing tenant context fails closed                         | `tenant_id` required by schema; provider double-checks and returns FAILURE, never a partial result                                        |
| Malformed input rejected                                    | `callSummaryInputSchema.strict()` - unknown fields, wrong types, oversized/empty transcripts all rejected                                 |
| Invalid output rejected                                     | Provider's own output is `.parse()`d against `callSummaryOutputSchema` before `SUCCESS` is ever returned                                  |
| Unauthorized capability rejected                            | Standard `core/permissions` MEDIUM-risk gate - `BLOCKED` without an explicit `ApprovalGate.decide()`                                      |
| Provider errors do not leak secrets                         | `execute()` catches unexpected errors and returns a generic, sanitized failure message, never raw exception text                          |
| Prompts/logs don't expose API keys/env vars                 | No API key or credential is used by the reference provider at all; `core/reporting/audit.ts` also scrubs any secret-shaped key regardless |
| Audit records metadata without storing sensitive transcript | `message`/evidence/audit only ever carry counts, flags, tenant reference, and timing - never transcript text                              |
