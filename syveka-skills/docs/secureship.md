# SecureShip — MVP Reference

SecureShip is Syveka's planned security-engineering product line, built as capabilities on the
same Syveka Master Skill governance architecture every other capability in this lab uses
(`docs/architecture.md`): intent → plan → route → permission → execute → evidence → verify →
report. This document is the concrete reference for the first SecureShip capability actually
built, `security.dependency_audit`, and the roadmap for the rest of the intended workflow.

## The intended SecureShip workflow

```
Inspect -> Detect -> Prioritize -> Explain -> Fix -> Test -> Verify -> Report
```

This MVP slice implements **Inspect → Detect → Prioritize → Explain → Report** only. Fix, Test,
and Verify are deliberately unimplemented - see "What remains intentionally unimplemented" below.

## Repository gap map (as of this milestone)

| Area                                    | State                      | Notes                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency vulnerability scanning (CI)  | **EXISTING**               | `scripts/run-npm-audit.ts` + `.github/workflows/ci.yml` (`production-dependency-audit`, `full-dependency-audit-report`) - a blocking CI gate, not a governed capability                                                                                                                       |
| Secret detection                        | **EXISTING**               | gitleaks, wired into `.github/workflows/ci.yml`'s `Secret scan` job - CI-only, not a capability                                                                                                                                                                                               |
| Syveka Skills governance architecture   | **EXISTING**               | proven end-to-end by the separate platform-proof work (Draft PR - see repo PR history); reused unmodified here                                                                                                                                                                                |
| Structured, governed dependency audit   | **NOW BUILT (this slice)** | `security.dependency_audit` - see below                                                                                                                                                                                                                                                       |
| SAST / static code analysis             | **MISSING**                | no CodeQL/Semgrep/eslint-security integration anywhere in this repository                                                                                                                                                                                                                     |
| Vulnerability fix generation            | **MISSING**                | not started - deliberately out of scope for this slice                                                                                                                                                                                                                                        |
| Automated fix verification (test+rerun) | **MISSING**                | not started - deliberately out of scope for this slice                                                                                                                                                                                                                                        |
| Security reporting/dashboarding         | **MISSING**                | this capability's structured output is the reporting primitive; no aggregation/UI layer exists yet                                                                                                                                                                                            |
| `skill.security_review` capability      | **PARTIAL (unrelated)**    | referenced in `core/intent`/`core/planner` for reviewing candidate _third-party Skills'_ provenance (see `docs/skills/SECURITY_REVIEW.md`) - a different concept from scanning this product's own dependency tree; no registry entry/provider exists for it either. Not touched by this work. |

**Do not build / avoid duplicating:** `scripts/run-npm-audit.ts`'s CI-blocking retry logic (a
different consumer - it gates CI builds, this capability serves the governed orchestrator loop);
`skill.security_review` (different capability, different problem); a second call-summary provider
(out of scope per this milestone's brief - that capability's purpose is already proven).

## First capability: `security.dependency_audit`

**Why this one first:** smallest useful vertical slice that exercises the full governance loop
end-to-end against a _real_ repository (this one - see "against a real repository" below), reusing
a tool this repo already trusts (`npm audit`) rather than inventing new detection logic.

- Capability id: `security.dependency_audit`
- Registry id: `security-dependency-audit-npm`
- Skill id (execution metadata): `secureship/dependency-audit`, version `1.0.0`

### Contract (`schemas/dependency-audit.ts`)

- `dependencyAuditInputSchema` (strict): `workspace_ref` (a label, never a filesystem path - see
  "Security" below), `tenant_ref` (optional, see "Why tenant enforcement does not apply here"),
  `ecosystem` (currently `"npm"` only), `policy` (optional `minimum_severity`/`production_only`/
  `max_findings` overrides).
- `dependencyAuditOutputSchema` (strict): `ecosystem`, `scanned_dependency_count`, `findings[]`
  (package, installed_version, affected_range, severity, advisory_id, advisory_url, title,
  classification, fix_available, recommended_action, evidence_ref, cwe[], cvss_score),
  `risk_summary` (total/by-severity/direct-vs-transitive/fixable counts, `overall_risk`),
  `truncated`.
- A provider's raw output is only ever treated as a result after it round-trips through
  `dependencyAuditOutputSchema.parse()`.

### Policy (`policies/risk-classification.ts`)

`security.dependency_audit.execute` is classified **LOW** risk (no approval required) - matching
`test.run.local`/`web.research.public`'s precedent: a read-only inspection of package metadata
already public in this repo's own lockfile. `npm audit` does call registry.npmjs.org's public
advisory endpoint, but that read-only query carries no tenant/customer data, the same reasoning
Scrapling's plain-HTTP research tier already established for LOW-despite-network-access. This is
deliberately different from `dependency.install` (MEDIUM, writes new packages into the project) -
this capability only ever reads and reports, never modifies `package.json`/`package-lock.json`.

### Runtime (`core/orchestrator.ts`) - unmodified

Unlike the separate platform-proof work (which added an optional `OrchestratorDeps.context`
field), this capability's branch was deliberately built to need **zero changes to
`core/orchestrator.ts`**, so it can be branched cleanly from `main` without depending on any
unmerged code - see "Git strategy" below. Structured input (workspace_ref/ecosystem/policy) comes
from the provider's own constructor defaults when a call has no structured payload (the normal
orchestrator path today), and can still be overridden by a directly-shaped call or, once the
`context` field lands, by a real per-call payload - see `providers/dependency-audit/index.ts`'s
"INPUT RESOLUTION" doc comment for the exact precedence.

### Provider (`providers/dependency-audit/`)

- `index.ts` — the reference provider: spawns real `npm audit --json` (argv array, never a shell
  string), cross-references `package-lock.json` for installed versions, validates its own output
  before returning `SUCCESS`. Every external call (`spawnSync`, lockfile read) is injectable
  (`runAudit`/`checkToolAvailable`/`getToolVersion`/`readLockfilePackages`) so evals can supply
  deterministic fixtures without a live process/network dependency, while the default path
  genuinely shells out.
- `npm-audit-parser.ts` — pure functions: `parseRawNpmAudit` (JSON.parse + zod shape validation of
  untrusted tool output), `normalizeNpmAudit` (prioritization + explanation +
  fix-recommendation text), `resolveInstalledVersion`.

### Trust model

**Deterministic scanners/tools establish evidence; AI can assist reasoning but cannot invent
security truth.** Detection in this slice is 100% `npm audit`'s own advisory database - the exact
same tool this repository's CI already gates merges on (`scripts/run-npm-audit.ts`). No LLM call
exists anywhere in `providers/dependency-audit/`. A future Explain/Prioritize enhancement could
have an LLM turn a finding's structured fields into a more readable narrative or draft a
remediation plan, but it would consume this capability's already-validated structured output as
input, never replace or override the `severity`/`advisory_id`/`fix_available` fields the scanner
itself produced.

### Why tenant enforcement does not apply the same way as `voice-pilot/call-summary`

`voice-pilot/call-summary` processes a specific tenant's private customer conversation - fail-
closed tenant scoping there prevents one tenant's data from ever being attributed to another.
`security.dependency_audit` inspects **this repository's own dependency tree** - metadata already
public in its lockfile, not any tenant's private data. There is no cross-tenant leak risk to
prevent, so `tenant_ref` is optional and used only for audit attribution (e.g. "which
org/workspace requested this scan," useful if this becomes a per-org paid feature later) -
never fail-closed-enforced. This is a deliberate architecture decision, not an oversight - see
`evals/dependency-audit-security.test.ts` "tenant context and honesty about unknowns".

### Security

| Requirement (task brief Phase 6)                                | How it's enforced                                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted repository content cannot override system policy      | `classifyRisk`/`requiresApproval`/`ApprovalGate` take only plain action-id strings, never scanner output                                                 |
| Malicious package names/descriptions cannot become instructions | Every npm-audit value flows through typed string fields only - JSON data, never executed, evaluated, or interpolated into a command                      |
| Malformed scanner output fails safely                           | `parseRawNpmAudit` combines `JSON.parse` + zod shape validation; any failure returns `FAILURE`, never a coerced/partial result                           |
| No environment secrets emitted into findings/reporting          | Provider never reads `process.env`; failure messages are generic, never raw stderr/exception text                                                        |
| Filesystem scope is constrained                                 | `cwd`/`ecosystem` fixed at provider construction; `workspace_ref` is a label only, never used for file access                                            |
| Capability permissions are enforced                             | Standard `core/permissions` gate - proven with a forced-HIGH BLOCKED test, same mechanism every other capability uses                                    |
| Tenant context fails closed where applicable                    | N/A here by design (see above) - tested explicitly, not silently skipped                                                                                 |
| Scanner/tool failure cannot be reported as a clean repository   | Spawn errors and malformed output always return `FAILURE`; a clean `SUCCESS` result only ever comes from a genuinely parsed, empty `vulnerabilities` map |
| Unknown/unverified findings represented honestly                | `installed_version`/`advisory_id`/`advisory_url` are nullable and left `null` when unresolvable, never guessed                                           |

### Evaluation (`evals/dependency-audit*.test.ts`)

- `evals/dependency-audit.test.ts` — contract validation; normal cases (clean set, vulnerable
  direct dependency, vulnerable transitive dependency, multiple severity levels, no fix available,
  fix available, `minimum_severity`/`max_findings` policy overrides); governance/orchestrator
  integration (COMPLETE/VERIFIED, BLOCKED when forced to a gated risk, CAPABILITY_UNAVAILABLE with
  no provider wired); and one test that runs **real** `npm audit` against this repository's own
  `syveka-skills/` lockfile (not fixture-only).
- `evals/dependency-audit-security.test.ts` — adversarial cases (prompt-injection-style advisory
  text, shell-metacharacter package names, malformed/wrong-shaped/unrecognized-severity scanner
  output, scanner tool unavailable, secret-looking advisory text never reaching the audit trail),
  filesystem-scope and permission-enforcement proofs, and the tenant-context tests above.

Run: `npm test` (from `syveka-skills/`).

## What remains intentionally unimplemented

- **Fix** — no automated dependency version bumps, no `npm audit fix` invocation, no PR creation.
  `recommended_action` is advisory text only.
- **Test** — no automated "does the fix break anything" step (would depend on Fix existing first).
- **Verify** — no automated "re-scan after fix and confirm the finding is gone" step.
- **SAST / static code analysis** — a second, complementary detection capability, not started.
- **Multi-ecosystem support** — `ecosystem` is a closed `"npm"`-only enum today; adding e.g. `pip`
  is a new provider under the same capability + a schema enum addition, not a redesign (see "How
  to add a second security capability" below).
- **Database-backed findings history / trend reporting** — this MVP is stateless per invocation,
  matching every other capability in this lab (`core/registry/data.ts` is still a static array).

## How to add a second SecureShip capability without duplicating architecture

Follow the same five-layer pattern this file documents: (1) a strict input/output contract in
`schemas/`, (2) a risk classification in `policies/risk-classification.ts`, (3) one new registry
entry in `core/registry/data.ts` under a new capability id, (4) a provider under `providers/`
implementing the shared `Provider` interface with real, deterministic (or clearly-labeled-stub)
detection logic - never an LLM inventing findings, (5) an intent rule + planner description so the
fallback classifier can route to it. Nothing in `core/orchestrator.ts`, `core/router`,
`core/permissions`, `core/evidence`, `core/verification`, or `core/reporting` should ever need to
change for a new capability - if it does, that is a signal the new capability doesn't actually fit
this architecture, not a reason to special-case the orchestrator.

## Git strategy

This capability was branched directly from `origin/main`, not from the separate (unmerged)
platform-proof branch, and was deliberately designed to need no change to
`core/orchestrator.ts` - see "Runtime" above. It does not stack on, depend on, or mix history with
that other work.
