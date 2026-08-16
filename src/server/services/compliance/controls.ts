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
  if (!before) throw new Error("Control not found");
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

const MAX_SUMMARY_LENGTH = 1000;
const MAX_SOURCE_IDENTIFIER_LENGTH = 500;

/** Common credential shapes -- a reference/summary should never look like one of these. */
const SECRET_SHAPE_PATTERNS = [
  /\bsk_(live|test)_[a-zA-Z0-9]+/, // Stripe secret keys
  /\bwhsec_[a-zA-Z0-9]+/, // Stripe/Svix webhook secrets
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key IDs
  /\bgh[pousr]_[a-zA-Z0-9]{20,}/, // GitHub tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
  /\bBearer\s+[a-zA-Z0-9._-]{20,}/i, // bearer tokens
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/, // JWT-shaped
];

/**
 * Fail closed rather than silently store: evidence fields are references
 * (a CI run URL, a test file path, a short summary), never raw payloads or
 * credentials (Step 5's security requirement). Length caps stop someone
 * pasting a full log/response dump in as "evidence"; the pattern list
 * catches the most common credential shapes. Not exhaustive -- this is a
 * guardrail against accidental misuse, not a substitute for reviewing what
 * gets passed in.
 */
function assertEvidenceTextIsSafe(summary: string, sourceIdentifier: string) {
  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new Error(
      `Evidence summary exceeds ${MAX_SUMMARY_LENGTH} characters -- store a reference, not a payload`,
    );
  }
  if (sourceIdentifier.length > MAX_SOURCE_IDENTIFIER_LENGTH) {
    throw new Error(
      `Evidence sourceIdentifier exceeds ${MAX_SOURCE_IDENTIFIER_LENGTH} characters -- store a reference, not a payload`,
    );
  }
  for (const pattern of SECRET_SHAPE_PATTERNS) {
    if (pattern.test(summary) || pattern.test(sourceIdentifier)) {
      throw new Error(
        "Evidence text matches a known credential shape -- never store secrets/tokens as compliance evidence",
      );
    }
  }
}

export async function addEvidence(input: AddEvidenceInput) {
  const { userId } = await requireSuperadmin();
  assertEvidenceTextIsSafe(input.summary, input.sourceIdentifier);
  const evidence = await unscopedPrisma.complianceEvidence.create({ data: input });
  await complianceAudit(userId, {
    action: "compliance_evidence.create",
    resourceType: "ComplianceEvidence",
    resourceId: evidence.id,
    after: evidence,
  });
  return evidence;
}
