# Syveka Master Skill — Architecture

## Directory structure

```
syveka-skills/
├── core/               orchestration engine - model-agnostic, no external network calls
│   ├── intent/         request -> TaskType + capability list (deterministic fallback classifier)
│   ├── planner/         intent -> ordered Plan
│   ├── router/          capability -> approved, available provider
│   ├── permissions/      action -> risk level -> approval requirement
│   ├── approvals/        approval request builder + in-memory approval gate
│   ├── evidence/         evidence collection + sufficiency evaluation
│   ├── verification/     the evidence-first gate (VERIFIED/UNVERIFIED/FAILED)
│   ├── reporting/        audit log, secret scrubbing, TaskReport builder
│   ├── registry/         the Skills Registry (data + lookup functions)
│   └── orchestrator.ts   ties the above into runTask()
├── providers/          capability implementations, real or honestly-stubbed
│   ├── local-test-runner/     REAL - runs a command via execFile
│   ├── git-diff/               REAL - captures a real git diff
│   ├── skill-registry-lookup/  REAL - searches the actual registry
│   ├── shadcn-mcp/             STUB - not connected in this environment
│   ├── twentyfirst-dev/        STUB - not connected in this environment
│   ├── scrapling/              STUB - reviewed, not installed (see docs/skills/SECURITY_REVIEW.md)
│   └── claude-video/           STUB - not yet reviewed
├── adapters/            translate the shared capability list into a target agent's format
│   ├── claude-code/     REAL - generates an actual SKILL.md
│   ├── codex/            format-only, UNVERIFIED against a live Codex CLI
│   └── gemini/            format-only, UNVERIFIED against a live Gemini CLI
├── policies/             data-driven risk classification rules
├── schemas/              zod schemas - the shared contract every layer is built against
├── evals/                behavioral tests proving the governance properties, not just unit coverage
├── examples/              the 3 MVP demo scenarios
└── docs/                 this directory
```

`capabilities/` from the originally proposed tree was folded into `core/registry/` +
`core/planner/`'s description map rather than kept as a separate directory: in this MVP, "what a
capability means" is fully expressed by (a) its id, (b) its registry entry, and (c) its plan-step
description — a separate `capabilities/` module would have just re-stated the same three things a
third time. Revisit this once there are enough capabilities that the taxonomy needs its own
documentation layer independent of the registry.

## The orchestration loop, concretely

```
runTask(taskId, request, { providerMap, approvalGate, actionForCapability })
  1. classifyIntent(request)              -> core/intent
  2. buildPlan(intent)                    -> core/planner
  3. for each plan step:
       routeCapability(capability, providerMap)   -> core/router (queries core/registry)
       checkPermission(action)                     -> core/permissions (queries policies/)
       if approval required: buildApprovalRequest + approvalGate.request()  -> core/approvals
       if not approved: BLOCK, stop
       provider.execute(...)                        -> providers/*
       collector.attach(evidence)                    -> core/evidence
  4. verify({ evidence, providerOutcome })            -> core/verification
  5. buildReport(...)                                  -> core/reporting
```

Every step above records a structured `AuditEvent` (`core/reporting/audit.ts`), scrubbed of
anything credential-shaped before it's stored - see `docs/security-model.md`.

## Design decisions worth explaining

**Why the router stops at the first unavailable step instead of skipping ahead.** A plan is an
ordered sequence for a reason - later steps often depend on earlier ones' output (e.g.
`engineering.diff_capture` after `engineering.test`). Silently skipping an unavailable step and
continuing would let a report say "COMPLETE" for a task that only partially ran. See
`core/orchestrator.ts`.

**Why HIGH and MEDIUM risk are both gated by default, not just HIGH.** The product brief lists
"installing dependencies" and "modifying project files" as MEDIUM examples - both are still things
a human should be able to see before they happen in an MVP with no track record yet. This is a
default, not a hard law - see `docs/security-model.md` for how a real deployment might relax
MEDIUM per-org once the platform has an audit history to justify it.

**Why `verify()` never reads a `userAssertsComplete`-style flag.** This is the mechanical
implementation of anti-sycophancy - see `docs/evidence-model.md` and
`evals/anti-sycophancy.test.ts`.

**Why the intent classifier is keyword-based, not an LLM call.** See `core/intent/index.ts`'s
module doc comment and `docs/product-vision.md` "Where the LLM fits" - the host agent is expected
to be the real classifier in production; this module is the deterministic, eval-testable fallback
and the taxonomy the host agent reads.

## Adapter architecture

`adapters/shared-capability-list.ts` is the only thing every adapter imports for "what can Syveka
do" - it reads directly from `core/registry`. `adapters/claude-code` renders that into a real
SKILL.md; `adapters/codex` and `adapters/gemini` render the same data into a generic
instructions-plus-JSON-manifest shape. No adapter owns a second copy of capability logic - see
`evals/model-portability.test.ts`, which asserts this directly rather than trusting the doc
comment.
