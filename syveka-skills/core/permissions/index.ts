import { classifyRisk } from "../../policies/risk-classification.js";
import type { RiskLevel } from "../../schemas/index.js";

export { classifyRisk };

/**
 * Whether an action of a given risk level requires an explicit human
 * approval gate before it can proceed. HIGH is always gated - not
 * configurable, since that's exactly the category the product exists to
 * protect (§9 "Never bypass human approvals"). MEDIUM is gated too in this
 * MVP's default policy; a real deployment could relax MEDIUM per-org, but
 * HIGH staying non-configurable is a deliberate product boundary, not an
 * oversight.
 */
export function requiresApproval(risk: RiskLevel): boolean {
  return risk === "HIGH" || risk === "MEDIUM";
}

export interface PermissionCheck {
  action: string;
  risk: RiskLevel;
  approvalRequired: boolean;
}

export function checkPermission(action: string): PermissionCheck {
  const risk = classifyRisk(action);
  return { action, risk, approvalRequired: requiresApproval(risk) };
}
