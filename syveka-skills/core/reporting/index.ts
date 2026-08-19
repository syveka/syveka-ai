import type { AuditEvent, Plan, TaskReport, VerificationResult } from "../../schemas/index.js";

export { AuditLog, scrub } from "./audit.js";

export function statusFromVerification(
  verification: VerificationResult,
  blocked: boolean,
  capabilityUnavailable: boolean,
): TaskReport["status"] {
  if (blocked) return "BLOCKED";
  if (capabilityUnavailable) return "CAPABILITY_UNAVAILABLE";
  if (verification.status === "VERIFIED") return "COMPLETE";
  if (verification.status === "FAILED") return "FAILED";
  return "UNVERIFIED";
}

export function buildReport(params: {
  taskId: string;
  request: string;
  plan: Plan;
  verification: VerificationResult;
  auditTrail: AuditEvent[];
  blocked?: boolean;
  capabilityUnavailable?: boolean;
}): TaskReport {
  const status = statusFromVerification(
    params.verification,
    params.blocked ?? false,
    params.capabilityUnavailable ?? false,
  );

  const summary =
    status === "COMPLETE"
      ? `Completed and verified: ${params.verification.reason}`
      : status === "BLOCKED"
        ? "Blocked pending human approval - see audit trail for the pending permission_requested event."
        : status === "CAPABILITY_UNAVAILABLE"
          ? "The required capability has no available approved provider right now. Reported honestly rather than fabricating a result."
          : status === "FAILED"
            ? `Not completed: ${params.verification.reason}`
            : `Unverified: ${params.verification.reason}`;

  return {
    task_id: params.taskId,
    request: params.request,
    plan: params.plan,
    verification: params.verification,
    status,
    summary,
    audit_trail: params.auditTrail,
  };
}

export function renderReportMarkdown(report: TaskReport): string {
  const lines: string[] = [
    `# Task Report: ${report.task_id}`,
    "",
    `**Request:** ${report.request}`,
    `**Status:** ${report.status}`,
    "",
    `## Summary`,
    report.summary,
    "",
    `## Plan`,
    ...report.plan.steps.map((s, i) => `${i + 1}. **${s.capability}** - ${s.description}`),
    "",
    `## Verification`,
    `- Status: ${report.verification.status}`,
    `- Reason: ${report.verification.reason}`,
    `- Evidence items: ${report.verification.evidence.items.length}`,
    ...report.verification.evidence.items.map(
      (e) => `  - [${e.type}] ${e.description} (${e.timestamp})`,
    ),
    "",
    `## Audit trail`,
    ...report.audit_trail.map((e) => `- \`${e.timestamp}\` ${e.type}`),
  ];
  return lines.join("\n");
}
