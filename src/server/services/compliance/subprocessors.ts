import "server-only";

import type {
  DpaStatus,
  ReviewStatus,
  RiskLevel,
  SubprocessorRole,
  TransferSafeguard,
} from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listSubprocessors() {
  await requireSuperadmin();
  return unscopedPrisma.subprocessor.findMany({ orderBy: { name: "asc" } });
}

export type CreateSubprocessorInput = {
  name: string;
  servicePurpose: string;
  dataCategories: string;
  role?: SubprocessorRole;
  region?: string;
  dataResidency?: string;
  internationalTransfer?: TransferSafeguard;
  dpaStatus?: DpaStatus;
  securityReviewStatus?: ReviewStatus;
  riskLevel?: RiskLevel;
  notes?: string;
};

/**
 * Every UNKNOWN-capable field defaults to UNKNOWN in the schema -- do not
 * pass a guessed value here. Populate only from a verified DPA or the
 * vendor's own published documentation.
 */
export async function createSubprocessor(input: CreateSubprocessorInput) {
  const { userId } = await requireSuperadmin();
  const subprocessor = await unscopedPrisma.subprocessor.create({
    data: { ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "subprocessor.create",
    resourceType: "Subprocessor",
    resourceId: subprocessor.id,
    after: subprocessor,
  });
  return subprocessor;
}

export async function updateSubprocessor(id: string, input: Partial<CreateSubprocessorInput>) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.subprocessor.findUnique({ where: { id } });
  const subprocessor = await unscopedPrisma.subprocessor.update({ where: { id }, data: input });
  await complianceAudit(userId, {
    action: "subprocessor.update",
    resourceType: "Subprocessor",
    resourceId: subprocessor.id,
    before,
    after: subprocessor,
  });
  return subprocessor;
}

export async function deactivateSubprocessor(id: string) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.subprocessor.findUnique({ where: { id } });
  const subprocessor = await unscopedPrisma.subprocessor.update({
    where: { id },
    data: { active: false },
  });
  await complianceAudit(userId, {
    action: "subprocessor.deactivate",
    resourceType: "Subprocessor",
    resourceId: subprocessor.id,
    before,
    after: subprocessor,
  });
  return subprocessor;
}
