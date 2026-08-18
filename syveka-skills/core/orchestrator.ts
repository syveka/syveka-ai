import { classifyIntent } from "./intent/index.js";
import { buildPlan } from "./planner/index.js";
import { routeCapability } from "./router/index.js";
import { checkPermission } from "./permissions/index.js";
import { buildApprovalRequest, ApprovalGate } from "./approvals/index.js";
import { EvidenceCollector } from "./evidence/index.js";
import { verify } from "./verification/index.js";
import { AuditLog, buildReport, statusFromVerification } from "./reporting/index.js";
import type { Provider } from "../providers/types.js";
import type { TaskReport } from "../schemas/index.js";

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
  let lastOutcome: "SUCCESS" | "FAILURE" | "UNAVAILABLE" = "UNAVAILABLE";
  let blocked = false;
  let capabilityUnavailable = false;

  for (const step of plan.steps) {
    audit.record("capability_selected", { capability: step.capability });

    const route = await routeCapability(step.capability, deps.providerMap);

    if (route.outcome === "NO_APPROVED_PROVIDER" || route.outcome === "PROVIDER_UNAVAILABLE") {
      audit.record("provider_unavailable", { capability: step.capability, outcome: route.outcome });
      capabilityUnavailable = true;
      lastOutcome = "UNAVAILABLE";
      break;
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
        blocked = true;
        break;
      }
      audit.record("permission_granted", { action, decision });
    }

    const result = await route.provider.execute({ capability: step.capability, request });
    audit.record("tool_executed", { capability: step.capability, status: result.status });
    // The provider's own message is always recorded as (weak) log evidence,
    // even on success - a "no matches found" or "0 rows" result is real
    // information the report must surface, not just a bare COMPLETE status
    // with no explanation of what was actually found.
    collector.attach({
      type: "log",
      description: `${step.capability}: ${result.message}`,
      data: result.message,
    });
    for (const item of result.evidence) {
      collector.attach(item);
      audit.record("artifact_created", { type: item.type, description: item.description });
    }

    lastOutcome =
      result.status === "SUCCESS"
        ? "SUCCESS"
        : result.status === "FAILURE"
          ? "FAILURE"
          : "UNAVAILABLE";
    if (lastOutcome !== "SUCCESS") {
      if (lastOutcome === "UNAVAILABLE") capabilityUnavailable = true;
      break;
    }
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
