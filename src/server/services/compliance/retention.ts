import "server-only";

import type { RetentionExecutionStatus } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listRetentionPolicies() {
  await requireSuperadmin();
  return unscopedPrisma.retentionPolicy.findMany({ orderBy: { dataCategory: "asc" } });
}

export type CreateRetentionPolicyInput = {
  dataCategory: string;
  retentionPeriod: string;
  tenantOverridable?: boolean;
  legalHoldSupported?: boolean;
  notes?: string;
};

export async function createRetentionPolicy(input: CreateRetentionPolicyInput) {
  const { userId } = await requireSuperadmin();
  const policy = await unscopedPrisma.retentionPolicy.create({ data: input });
  await complianceAudit(userId, {
    action: "retention_policy.create",
    resourceType: "RetentionPolicy",
    resourceId: policy.id,
    after: policy,
  });
  return policy;
}

/**
 * Records that a retention/deletion decision was made or carried out --
 * this is evidence, not the deletion mechanism itself. Phase 1 does not run
 * destructive deletion; see docs/compliance/OPERATIONS.md.
 */
export async function recordRetentionExecution(input: {
  retentionPolicyId?: string;
  dataCategory: string;
  scheduledFor?: Date;
  status: RetentionExecutionStatus;
  recordCount?: number;
  notes?: string;
}) {
  const { userId } = await requireSuperadmin();
  const execution = await unscopedPrisma.retentionExecution.create({
    data: {
      ...input,
      executedAt: input.status === "EXECUTED" ? new Date() : undefined,
    },
  });
  await complianceAudit(userId, {
    action: "retention_execution.create",
    resourceType: "RetentionExecution",
    resourceId: execution.id,
    after: execution,
  });
  return execution;
}
