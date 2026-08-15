import "server-only";

import type {
  ClaimVerificationState,
  ComplianceFramework,
  ControlCategory,
  ControlImplementationStatus,
  EvidenceResultStatus,
  EvidenceSourceType,
} from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listControls() {
  await requireSuperadmin();
  return unscopedPrisma.complianceControl.findMany({
    orderBy: [{ category: "asc" }, { controlKey: "asc" }],
    include: { frameworkMappings: true },
  });
}

export async function getControl(id: string) {
  await requireSuperadmin();
  return unscopedPrisma.complianceControl.findUnique({
    where: { id },
    include: { frameworkMappings: true, evidence: true },
  });
}

export type CreateControlInput = {
  controlKey: string;
  title: string;
  description: string;
  category: ControlCategory;
  implementationStatus?: ControlImplementationStatus;
  verificationState?: ClaimVerificationState;
  reviewDate?: Date;
  implementationNotes?: string;
  exceptionNotes?: string;
};

export async function createControl(input: CreateControlInput) {
  const { userId } = await requireSuperadmin();
  const control = await unscopedPrisma.complianceControl.create({
    data: { ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "compliance_control.create",
    resourceType: "ComplianceControl",
    resourceId: control.id,
    after: control,
  });
  return control;
}

export type UpdateControlInput = Partial<CreateControlInput>;

export async function updateControl(id: string, input: UpdateControlInput) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.complianceControl.findUnique({ where: { id } });
  const control = await unscopedPrisma.complianceControl.update({ where: { id }, data: input });
  await complianceAudit(userId, {
    action: "compliance_control.update",
    resourceType: "ComplianceControl",
    resourceId: control.id,
    before,
    after: control,
  });
  return control;
}

export async function addFrameworkMapping(
  controlId: string,
  framework: ComplianceFramework,
  frameworkReference: string,
  notes?: string,
) {
  const { userId } = await requireSuperadmin();
  const mapping = await unscopedPrisma.controlFrameworkMapping.create({
    data: { controlId, framework, frameworkReference, notes },
  });
  await complianceAudit(userId, {
    action: "control_framework_mapping.create",
    resourceType: "ControlFrameworkMapping",
    resourceId: mapping.id,
    after: mapping,
  });
  return mapping;
}

export type AddEvidenceInput = {
  controlId: string;
  sourceType: EvidenceSourceType;
  sourceIdentifier: string;
  resultStatus: EvidenceResultStatus;
  summary: string;
  contentHash?: string;
  collectedAt: Date;
  reviewDueAt?: Date;
};

/** `summary`/`sourceIdentifier` must be references, never secrets/tokens/raw payloads/PII. */
export async function addEvidence(input: AddEvidenceInput) {
  const { userId } = await requireSuperadmin();
  const evidence = await unscopedPrisma.complianceEvidence.create({ data: input });
  await complianceAudit(userId, {
    action: "compliance_evidence.create",
    resourceType: "ComplianceEvidence",
    resourceId: evidence.id,
    after: evidence,
  });
  return evidence;
}
