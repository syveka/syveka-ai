import "server-only";

import type { DpiaRequirement, LawfulBasis } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listProcessingRecords() {
  await requireSuperadmin();
  return unscopedPrisma.processingRecord.findMany({ orderBy: { activityKey: "asc" } });
}

export type CreateProcessingRecordInput = {
  activityKey: string;
  name: string;
  purpose: string;
  dataCategories: string;
  dataSubjectCategories: string;
  lawfulBasis: LawfulBasis;
  recipients?: string;
  processorNotes?: string;
  retentionPeriod: string;
  internationalTransfers?: string;
  safeguards?: string;
  systemLocation?: string;
  reviewDate?: Date;
  dpiaStatus?: DpiaRequirement;
};

/** `lawfulBasis` is one of six values -- CONSENT is never assumed by default. */
export async function createProcessingRecord(input: CreateProcessingRecordInput) {
  const { userId } = await requireSuperadmin();
  const record = await unscopedPrisma.processingRecord.create({
    data: { ownerUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "processing_record.create",
    resourceType: "ProcessingRecord",
    resourceId: record.id,
    after: record,
  });
  return record;
}

export async function updateProcessingRecord(
  id: string,
  input: Partial<CreateProcessingRecordInput>,
) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.processingRecord.findUnique({ where: { id } });
  if (!before) throw new Error("Processing record not found");
  const record = await unscopedPrisma.processingRecord.update({ where: { id }, data: input });
  await complianceAudit(userId, {
    action: "processing_record.update",
    resourceType: "ProcessingRecord",
    resourceId: record.id,
    before,
    after: record,
  });
  return record;
}
