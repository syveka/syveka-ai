import type { ApprovalRequest, RiskLevel } from "../../schemas/index.js";

/**
 * Builds the structured disclosure a gated action must produce before a
 * human can meaningfully approve or deny it - see §"Approval Gates" in the
 * product brief. This is deliberately just a data builder: this MVP does
 * not implement a real approval channel (Slack/email/UI). See
 * docs/mvp.md and docs/security-model.md for what a real approval
 * transport would need to be wired to before this can gate a live,
 * unattended action rather than a demo one.
 */
export function buildApprovalRequest(params: {
  action: string;
  risk: RiskLevel;
  reason: string;
  expectedEffect: string;
  rollbackPlan: string;
}): ApprovalRequest {
  return {
    requested_action: params.action,
    reason: params.reason,
    risk: params.risk,
    expected_effect: params.expectedEffect,
    rollback_plan: params.rollbackPlan,
  };
}

export type ApprovalDecision = "APPROVED" | "DENIED" | "PENDING";

/**
 * In-memory approval gate for the MVP. There is intentionally no
 * `autoApprove()` method and no default-approve path: a request that is
 * never explicitly decided stays PENDING forever, which is the honest
 * behavior for a system with no real human-approval transport wired up yet
 * - it must never silently proceed just because nobody said no.
 */
export class ApprovalGate {
  private decisions = new Map<string, ApprovalDecision>();

  request(id: string): ApprovalDecision {
    if (!this.decisions.has(id)) {
      this.decisions.set(id, "PENDING");
    }
    return this.decisions.get(id)!;
  }

  /** Only a human-driven call site should ever invoke this - never the orchestrator itself. */
  decide(id: string, decision: "APPROVED" | "DENIED"): void {
    this.decisions.set(id, decision);
  }

  status(id: string): ApprovalDecision {
    return this.decisions.get(id) ?? "PENDING";
  }
}
