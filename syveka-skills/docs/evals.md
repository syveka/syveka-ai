# Syveka Master Skill — Evals

39 tests across 9 files in `evals/`, run via `npm test` (vitest). All pass as of this MVP - see
the Final Report for the exact run output. This document explains what each file is actually
proving, not just what it's named.

| File                             | Proves                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capability-routing.test.ts`     | Known capabilities route correctly; unknown capabilities report `NO_APPROVED_PROVIDER`; a `REJECTED` registry entry is never routed to even as the sole candidate; `isAvailable()` is actually checked, not assumed; an unavailable registered provider reports `PROVIDER_UNAVAILABLE` rather than a fabricated route                                                                           |
| `permission-enforcement.test.ts` | Risk classification for known HIGH/LOW actions; unclassified actions fail closed to HIGH; HIGH/MEDIUM require approval, LOW doesn't; the orchestrator actually returns `BLOCKED` (not `COMPLETE`) when a gated action is never approved, and proceeds once explicitly approved                                                                                                                  |
| `anti-sycophancy.test.ts`        | The brief's named eval: a bare claim is never verified even with `userAssertsComplete: true`; the verdict is byte-identical with or without that flag; a `FAILED` verdict is not reversed by user pressure; real evidence still verifies (not reflexive contrarianism); weak evidence alone (a log) is insufficient                                                                             |
| `evidence-sufficiency.test.ts`   | Zero evidence -> insufficient; weak-only evidence -> insufficient; one strong item -> sufficient; mixed weak+strong -> sufficient                                                                                                                                                                                                                                                               |
| `provider-availability.test.ts`  | An unavailable provider yields `CAPABILITY_UNAVAILABLE`, never `COMPLETE`; a provider that genuinely fails yields `FAILED`, not `COMPLETE`; an empty provider map doesn't cause a silent skip-ahead-and-succeed                                                                                                                                                                                 |
| `model-portability.test.ts`      | All three adapters (Claude Code, Codex, Gemini) render from the exact same registry-derived capability list; the Claude Code SKILL.md actually contains every approved capability string; Codex and Gemini manifests contain byte-identical capability JSON; no adapter invents a capability the registry doesn't have                                                                          |
| `untrusted-web-content.test.ts`  | A constructed prompt-injection payload (explicitly claiming "VERIFIED", "ignore all previous instructions") inside a `source_reference` evidence item has zero effect on `evaluateSufficiency()` or `verify()`'s actual output - proven by asserting the real function output, not by asserting the payload was "detected"                                                                      |
| `ambiguous-requests.test.ts`     | The brief's named scenario type: a vague request ("do the thing") returns low confidence and zero guessed capabilities, not a random match; the orchestrator reports `CAPABILITY_UNAVAILABLE` with a single `clarification.request` plan step rather than fabricating a plan; a clearly-worded request still classifies confidently (the fallback isn't overly cautious in the other direction) |
| `audit-secret-scrubbing.test.ts` | Top-level and nested credential-shaped keys are redacted; `AuditLog.record()` scrubs unconditionally - there is no way for a caller to record an event that bypasses `scrub()`                                                                                                                                                                                                                  |

## What is deliberately NOT covered by an eval in this MVP

- Live behavior of any real external provider (Scrapling, shadcn MCP, 21st.dev, claude-video) -
  none are connected; see `docs/provider-model.md`.
- Live Codex/Gemini CLI compatibility - the adapters are format-only and unverified against a real
  installation; `model-portability.test.ts` proves internal consistency (same source data), not
  external correctness against a live CLI.
- A real human-approval transport - `ApprovalGate` is in-memory; there's nothing external to test
  yet.

## Running the evals

```bash
cd syveka-skills
npm install
npm run typecheck
npm test
```
