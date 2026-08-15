import "server-only";

import type { RiskLevel, RiskStatus } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listRisks() {
  await requireSuperadmin();
  return unscopedPrisma.complianceRisk.findMany({ orderBy: { createdAt: "desc" } });
}

export type CreateRiskInput = {
  riskKey: string;
  title: string;
  description: string;
  category: string;
  assetOrSystem: string;
  threatDescription: string;
  likelihood: RiskLevel;
  impact: RiskLevel;
  inherentRiskLevel: RiskLevel;
  mitigationControlId?: string;
  residualRiskLevel?: RiskLevel;
  reviewDate?: Date;
};

export async function createRisk(input: CreateRiskInput) {
  const { userId } = await requireSuperadmin();
  const risk = await unscopedPrisma.complianceRisk.create({
    data: { ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "compliance_risk.create",
    resourceType: "ComplianceRisk",
    resourceId: risk.id,
    after: risk,
  });
  return risk;
}

export async function updateRiskStatus(
  id: string,
  status: RiskStatus,
  residualRiskLevel?: RiskLevel,
) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.complianceRisk.findUnique({ where: { id } });
  if (!before) throw new Error("Risk not found");
  const risk = await unscopedPrisma.complianceRisk.update({
    where: { id },
    data: { status, residualRiskLevel },
  });
  await complianceAudit(userId, {
    action: "compliance_risk.update_status",
    resourceType: "ComplianceRisk",
    resourceId: risk.id,
    before,
    after: risk,
  });
  return risk;
}
