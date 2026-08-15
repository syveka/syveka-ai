import "server-only";

import type { AssessmentType, DpiaRequirement } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listAssessments() {
  await requireSuperadmin();
  return unscopedPrisma.privacySecurityAssessment.findMany({ orderBy: { createdAt: "desc" } });
}

export type CreateAssessmentInput = {
  assessmentKey: string;
  assessmentType: AssessmentType;
  featureOrSystem: string;
  reason: string;
  risksIdentified?: string;
  safeguards?: string;
  reviewDate?: Date;
};

/** `dpiaRequired` defaults to UNKNOWN -- never inferred automatically. */
export async function createAssessment(input: CreateAssessmentInput) {
  const { userId } = await requireSuperadmin();
  const assessment = await unscopedPrisma.privacySecurityAssessment.create({
    data: { ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "privacy_security_assessment.create",
    resourceType: "PrivacySecurityAssessment",
    resourceId: assessment.id,
    after: assessment,
  });
  return assessment;
}

export async function setDpiaRequirement(id: string, dpiaRequired: DpiaRequirement) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.privacySecurityAssessment.findUnique({ where: { id } });
  const assessment = await unscopedPrisma.privacySecurityAssessment.update({
    where: { id },
    data: { dpiaRequired },
  });
  await complianceAudit(userId, {
    action: "privacy_security_assessment.set_dpia_requirement",
    resourceType: "PrivacySecurityAssessment",
    resourceId: assessment.id,
    before,
    after: assessment,
  });
  return assessment;
}
