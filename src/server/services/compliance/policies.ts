import "server-only";

import type { PolicyStatus } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listPolicies() {
  await requireSuperadmin();
  return unscopedPrisma.securityPolicy.findMany({
    orderBy: [{ policyKey: "asc" }, { version: "desc" }],
  });
}

export type CreatePolicyInput = {
  policyKey: string;
  title: string;
  version: string;
  documentRef: string;
  effectiveDate?: Date;
  reviewDate?: Date;
  acknowledgementRequired?: boolean;
};

export async function createPolicy(input: CreatePolicyInput) {
  const { userId } = await requireSuperadmin();
  const policy = await unscopedPrisma.securityPolicy.create({
    data: { status: "DRAFT", ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "security_policy.create",
    resourceType: "SecurityPolicy",
    resourceId: policy.id,
    after: policy,
  });
  return policy;
}

export async function approvePolicy(id: string) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.securityPolicy.findUnique({ where: { id } });
  if (!before) throw new Error("Policy not found");
  const policy = await unscopedPrisma.securityPolicy.update({
    where: { id },
    data: {
      status: "APPROVED" satisfies PolicyStatus,
      approvedAt: new Date(),
      approvedByUserId: userId,
    },
  });
  await complianceAudit(userId, {
    action: "security_policy.approve",
    resourceType: "SecurityPolicy",
    resourceId: policy.id,
    before,
    after: policy,
  });
  return policy;
}

export async function acknowledgePolicy(policyId: string) {
  const { userId } = await requireSuperadmin();
  const ack = await unscopedPrisma.policyAcknowledgement.upsert({
    where: { policyId_userId: { policyId, userId } },
    create: { policyId, userId },
    update: {},
  });
  await complianceAudit(userId, {
    action: "policy_acknowledgement.create",
    resourceType: "PolicyAcknowledgement",
    resourceId: ack.id,
    after: ack,
  });
  return ack;
}
