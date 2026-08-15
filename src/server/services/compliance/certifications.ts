import "server-only";

import type { ClaimVerificationState, ComplianceFramework } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

const VERIFIED_STATES: ClaimVerificationState[] = ["EXTERNALLY_VERIFIED", "CERTIFIED"];

export async function listCertifications() {
  await requireSuperadmin();
  return unscopedPrisma.certification.findMany({ orderBy: { framework: "asc" } });
}

export type UpsertCertificationInput = {
  framework: ComplianceFramework;
  certificationType: string;
  scope: string;
  issuer?: string;
  issueDate?: Date;
  expiryDate?: Date;
  verificationReference?: string;
  verificationState: ClaimVerificationState;
};

/**
 * Claim safety (Step 18, docs/compliance/SECURITY_CLAIMS.md): a row may only
 * be marked EXTERNALLY_VERIFIED or CERTIFIED when both `issuer` and
 * `verificationReference` are populated. The database cannot verify an
 * external fact, so this is enforced here, at the only write path.
 */
export async function createCertification(input: UpsertCertificationInput) {
  const { userId } = await requireSuperadmin();
  assertClaimIsSupportable(input);
  const certification = await unscopedPrisma.certification.create({ data: input });
  await complianceAudit(userId, {
    action: "certification.create",
    resourceType: "Certification",
    resourceId: certification.id,
    after: certification,
  });
  return certification;
}

export async function updateCertification(id: string, input: Partial<UpsertCertificationInput>) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.certification.findUnique({ where: { id } });
  if (!before) throw new Error("Certification not found");
  const merged = { ...before, ...input };
  assertClaimIsSupportable(merged);
  const certification = await unscopedPrisma.certification.update({ where: { id }, data: input });
  await complianceAudit(userId, {
    action: "certification.update",
    resourceType: "Certification",
    resourceId: certification.id,
    before,
    after: certification,
  });
  return certification;
}

function assertClaimIsSupportable(input: {
  verificationState: ClaimVerificationState;
  issuer?: string | null;
  verificationReference?: string | null;
}) {
  if (!VERIFIED_STATES.includes(input.verificationState)) return;
  if (!input.issuer || !input.verificationReference) {
    throw new Error(
      `Cannot mark a certification ${input.verificationState} without both issuer and ` +
        "verificationReference (see docs/compliance/SECURITY_CLAIMS.md)",
    );
  }
}
