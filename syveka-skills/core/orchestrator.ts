import { classifyIntent } from "./intent/index.js";
import { buildPlan, describeCapability } from "./planner/index.js";
import { routeCapability } from "./router/index.js";
import { checkPermission } from "./permissions/index.js";
import { buildApprovalRequest, ApprovalGate } from "./approvals/index.js";
import { EvidenceCollector } from "./evidence/index.js";
import { verify } from "./verification/index.js";
import { AuditLog, buildReport, statusFromVerification } from "./reporting/index.js";
import type { Provider } from "../providers/types.js";
import type { PlanStep, RegistryEntry, TaskReport } from "../schemas/index.js";

/**
 * The Syveka Master Skill orchestrator: the concrete implementation of
 *
 *   Understand -> Classify -> Plan -> Select Capability -> Select Provider
 *   -> Check Permissions -> Execute -> Test -> Verify -> Report
 *
 * from the product brief. Every step here is deliberately small and
 * inspectable - the differentiated value is in the SEQUENCE and the GATES
 * (permission checks, evidence requirements, verification), not in any
 * single step being clever. See docs/architecture.md.
 */
export interface OrchestratorDeps {
  providerMap: Record<string, Provider>;
  approvalGate?: ApprovalGate;
  /**
   * Action id used for the permission check on the capability's execution
   * step - see policies/risk-classification.ts. Defaults to
   * "tool.generate.external" (MEDIUM) when not specified by the capability.
   */
  actionForCapability?: (capability: string) => string;
  /**
   * TEST-ONLY: overrides which registry entries routeCapability() considers
   * eligible for a given capability, instead of the real, committed
   * registry. Left unset (undefined), routing behaves exactly as it always
   * has - findByCapability() against the real registry. The only legitimate
   * use is a deterministic test proving the routing/permission/evidence
   * pipeline itself works correctly end-to-end, without needing a
   * REVIEW/REFERENCE capability to actually become routable in production -
   * see evals/voice-call-summary.test.ts. Same trust boundary as
   * `providerMap` itself: both are supplied by first-party calling code,
   * never by an external Skill/provider/agent, and neither ever touches the
   * committed registry data.
   */
  registryOverrideForCapability?: (capability: string) => RegistryEntry[] | undefined;
}

type StepOutcome = "SUCCESS" | "FAILURE" | "UNAVAILABLE";

interface StepExecutionResult {
  outcome: StepOutcome;
  blocked: boolean;
  capabilityUnavailable: boolean;
}

/**
 * Route -> permission-check -> execute -> collect evidence for exactly one
 * plan step. Shared by both entrypoints below (runTask's free-text path and
 * runStructuredTask's structured-input path) so the routing/policy/evidence
 * gates are defined ONCE - a caller cannot reach a provider through either
 * entrypoint without going through routeCapability and checkPermission
 * first. `providerInput` is the only thing that differs between the two
 * callers: runTask always sends `{ capability, request }` (unchanged,
 * existing behavior); runStructuredTask sends `{ capability, ...input }`.
 */
async function executeStep(
  taskId: string,
  step: PlanStep,
  providerInput: Record<string, unknown>,
  deps: OrchestratorDeps,
  audit: AuditLog,
  collector: EvidenceCollector,
  approvalGate: ApprovalGate,
): Promise<StepExecutionResult> {
  audit.record("capability_selected", { capability: step.capability });

  // Passing `undefined` explicitly (the common case - no override configured)
  // triggers routeCapability()'s own default parameter, which reads the
  // real registry exactly as it always has.
  const registryOverride = deps.registryOverrideForCapability?.(step.capability);
  const route = await routeCapability(step.capability, deps.providerMap, registryOverride);

  if (route.outcome === "NO_APPROVED_PROVIDER" || route.outcome === "PROVIDER_UNAVAILABLE") {
    audit.record("provider_unavailable", { capability: step.capability, outcome: route.outcome });
    return { outcome: "UNAVAILABLE", blocked: false, capabilityUnavailable: true };
  }

  audit.record("provider_selected", {
    capability: step.capability,
    provider: route.entry.provider,
  });

  const action = deps.actionForCapability?.(step.capability) ?? "tool.generate.external";
  const permission = checkPermission(action);
  audit.record("permission_requested", { action, risk: permission.risk });

  if (permission.approvalRequired) {
    const approval = buildApprovalRequest({
      action,
      risk: permission.risk,
      reason: `Capability "${step.capability}" requires ${permission.risk} risk approval`,
      expectedEffect: step.description,
      rollbackPlan: "No action has been taken yet; nothing to roll back until approved.",
    });
    const requestId = `${taskId}:${step.capability}`;
    const decision = approvalGate.request(requestId);
    if (decision !== "APPROVED") {
      audit.record("permission_denied", { action, decision, approval });
      return { outcome: "UNAVAILABLE", blocked: true, capabilityUnavailable: false };
    }
    audit.record("permission_granted", { action, decision });
  }

  const result = await route.provider.execute(providerInput);
  audit.record("tool_executed", { capability: step.capability, status: result.status });
  // The provider's own message is always recorded as (weak) log evidence,
  // even on success - a "no matches found" or "0 rows" result is real
  // information the report must surface, not just a bare COMPLETE status
  // with no explanation of what was actually found. Providers are
  // responsible for keeping this message free of secrets/PII (see
  // providers/voice-summary/deterministic-test-provider.ts for an example
  // that must never echo raw transcript content here) - the orchestrator
  // has no domain knowledge of what's sensitive in an arbitrary provider's
  // input, only core/reporting/audit.ts's generic credential-shaped-key scrub.
  collector.attach({
    type: "log",
    description: `${step.capability}: ${result.message}`,
    data: result.message,
  });
  for (const item of result.evidence) {
    collector.attach(item);
    audit.record("artifact_created", { type: item.type, description: item.description });
  }

  const outcome: StepOutcome =
    result.status === "SUCCESS"
      ? "SUCCESS"
      : result.status === "FAILURE"
        ? "FAILURE"
        : "UNAVAILABLE";
  return { outcome, blocked: false, capabilityUnavailable: outcome === "UNAVAILABLE" };
}

export async function runTask(
  taskId: string,
  request: string,
  deps: OrchestratorDeps,
): Promise<TaskReport> {
  const audit = new AuditLog(taskId);
  const approvalGate = deps.approvalGate ?? new ApprovalGate();
  audit.record("task_received", { request });

  const intent = classifyIntent(request);
  const plan = buildPlan(intent);
  audit.record("plan_created", { taskType: intent.taskType, steps: plan.steps.length });

  if (intent.confidence === "low") {
    const evidence = new EvidenceCollector(request).bundle();
    return buildReport({
      taskId,
      request,
      plan,
      verification: verify({ evidence, providerOutcome: "UNAVAILABLE" }),
      auditTrail: audit.all(),
      capabilityUnavailable: true,
    });
  }

  const collector = new EvidenceCollector(request);
  let lastOutcome: StepOutcome = "UNAVAILABLE";
  let blocked = false;
  let capabilityUnavailable = false;

  for (const step of plan.steps) {
    const stepResult = await executeStep(
      taskId,
      step,
      { capability: step.capability, request },
      deps,
      audit,
      collector,
      approvalGate,
    );
    lastOutcome = stepResult.outcome;
    if (stepResult.capabilityUnavailable) capabilityUnavailable = true;
    if (stepResult.blocked) {
      blocked = true;
      break;
    }
    if (lastOutcome !== "SUCCESS") break;
  }

  const verification = verify({ evidence: collector.bundle(), providerOutcome: lastOutcome });
  audit.record(verification.status === "VERIFIED" ? "verification_passed" : "verification_failed", {
    status: verification.status,
  });

  const finalStatus = statusFromVerification(verification, blocked, capabilityUnavailable);
  audit.record("report_generated", { status: finalStatus });

  return buildReport({
    taskId,
    request,
    plan,
    verification,
    auditTrail: audit.all(),
    blocked,
    capabilityUnavailable,
  });
}

export interface StructuredTaskRequest {
  /** Dotted capability id, e.g. "voice.summarize" - never free text. */
  capability: string;
  /**
   * Skill-specific structured payload (e.g. a validated CallSummaryInput).
   * Passed to the selected provider as `{ capability, ...input }`, matching
   * the flat-field convention providers/scrapling/index.ts already
   * established for its own structured field (`input.url`) - a provider
   * reads its own fields directly off the execute() argument, never nested
   * under an extra `input` key.
   *
   * NEVER logged or included in any audit event, evidence item, or the
   * report's own `request` field verbatim - it may contain sensitive
   * caller-supplied content (e.g. a call transcript). Only `capability` and
   * whatever the SELECTED PROVIDER'S OWN result explicitly returns are
   * ever recorded.
   */
  input: Record<string, unknown>;
  /** Reserved for future caller-supplied non-sensitive context; unused today. */
  context?: Record<string, unknown>;
}

/**
 * The structured-input analog of runTask(): for a caller that already knows
 * exactly which capability it wants and has a validated, Skill-specific
 * payload for it (not a free-text request to classify). Skips intent
 * classification/planning - the capability is a single explicit input, not
 * inferred - but goes through EXACTLY the same routing, permission, evidence,
 * verification, and audit machinery as runTask via the shared executeStep()
 * helper above. Does not add any provider-specific logic to the router or
 * registry: routeCapability() is called unchanged, so a REVIEW/REFERENCE
 * capability is exactly as unroutable here as it is through runTask.
 */
export async function runStructuredTask(
  taskId: string,
  req: StructuredTaskRequest,
  deps: OrchestratorDeps,
): Promise<TaskReport> {
  const audit = new AuditLog(taskId);
  const approvalGate = deps.approvalGate ?? new ApprovalGate();
  // Never req.input here - it may contain sensitive caller-supplied content.
  audit.record("task_received", { capability: req.capability, structured: true });

  const requestLabel = `structured:${req.capability}`;
  const plan = {
    steps: [{ capability: req.capability, description: describeCapability(req.capability) }],
  };
  audit.record("plan_created", { taskType: "structured", steps: plan.steps.length });

  const collector = new EvidenceCollector(requestLabel);
  const stepResult = await executeStep(
    taskId,
    plan.steps[0]!,
    { capability: req.capability, ...req.input },
    deps,
    audit,
    collector,
    approvalGate,
  );

  const verification = verify({
    evidence: collector.bundle(),
    providerOutcome: stepResult.outcome,
  });
  audit.record(verification.status === "VERIFIED" ? "verification_passed" : "verification_failed", {
    status: verification.status,
  });

  const finalStatus = statusFromVerification(
    verification,
    stepResult.blocked,
    stepResult.capabilityUnavailable,
  );
  audit.record("report_generated", { status: finalStatus });

  return buildReport({
    taskId,
    request: requestLabel,
    plan,
    verification,
    auditTrail: audit.all(),
    blocked: stepResult.blocked,
    capabilityUnavailable: stepResult.capabilityUnavailable,
  });
}
