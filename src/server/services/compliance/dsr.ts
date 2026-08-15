import "server-only";

import type { DsrStatus, DsrType, IdentityVerificationStatus } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

/** GDPR Art. 12(3) default response window. Adjustable per-request via `deadlineAt` if a shorter internal SLA applies -- not hard-coded into the schema. */
const DEFAULT_RESPONSE_WINDOW_DAYS = 30;

export async function listDataSubjectRequests() {
  await requireSuperadmin();
  return unscopedPrisma.dataSubjectRequest.findMany({ orderBy: { receivedAt: "desc" } });
}

export async function getDataSubjectRequest(id: string) {
  await requireSuperadmin();
  return unscopedPrisma.dataSubjectRequest.findUnique({
    where: { id },
    include: { events: { orderBy: { occurredAt: "asc" } } },
  });
}

export type CreateDsrInput = {
  requestKey: string;
  requestType: DsrType;
  subjectContactReference: string;
  relatedOrganizationId?: string;
  receivedAt: Date;
  deadlineAt?: Date;
};

export async function createDataSubjectRequest(input: CreateDsrInput) {
  const { userId } = await requireSuperadmin();
  const deadlineAt =
    input.deadlineAt ??
    new Date(input.receivedAt.getTime() + DEFAULT_RESPONSE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const request = await unscopedPrisma.dataSubjectRequest.create({
    data: { ...input, deadlineAt, assignedOwnerUserId: userId },
  });
  await complianceAudit(userId, {
    action: "data_subject_request.create",
    resourceType: "DataSubjectRequest",
    resourceId: request.id,
    after: request,
  });
  return request;
}

export async function setIdentityVerification(id: string, status: IdentityVerificationStatus) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.dataSubjectRequest.findUnique({ where: { id } });
  if (!before) throw new Error("Request not found");
  const request = await unscopedPrisma.dataSubjectRequest.update({
    where: { id },
    data: { identityVerificationStatus: status },
  });
  await complianceAudit(userId, {
    action: "data_subject_request.set_identity_verification",
    resourceType: "DataSubjectRequest",
    resourceId: request.id,
    before,
    after: request,
  });
  return request;
}

/**
 * Identity must be VERIFIED before a request can move to IN_PROGRESS or
 * COMPLETED -- see tests/unit/compliance-workflows.test.ts. WITHDRAWN and
 * REJECTED are both exempt: WITHDRAWN because the requester pulled the
 * request themselves, REJECTED because "we could not verify who you are"
 * is itself a legitimate, common rejection reason -- requiring VERIFIED
 * identity before REJECTED would make that outcome unreachable.
 */
export async function updateDsrStatus(id: string, status: DsrStatus, rejectionReason?: string) {
  const { userId } = await requireSuperadmin();
  const before = await unscopedPrisma.dataSubjectRequest.findUnique({ where: { id } });
  if (!before) throw new Error("Request not found");
  const identityExemptStatuses: DsrStatus[] = ["RECEIVED", "WITHDRAWN", "REJECTED"];
  if (
    !identityExemptStatuses.includes(status) &&
    before.identityVerificationStatus !== "VERIFIED"
  ) {
    throw new Error("Identity must be verified before processing this request");
  }
  const request = await unscopedPrisma.dataSubjectRequest.update({
    where: { id },
    data: {
      status,
      rejectionReason,
      completedAt: status === "COMPLETED" ? new Date() : undefined,
    },
  });
  await complianceAudit(userId, {
    action: "data_subject_request.update_status",
    resourceType: "DataSubjectRequest",
    resourceId: request.id,
    before,
    after: request,
  });
  return request;
}

/** Append-only: no corresponding update/delete is exposed. */
export async function addDsrEvent(requestId: string, occurredAt: Date, description: string) {
  const { userId } = await requireSuperadmin();
  const event = await unscopedPrisma.dsrEvent.create({
    data: { requestId, occurredAt, description, createdByUserId: userId },
  });
  await complianceAudit(userId, {
    action: "dsr_event.create",
    resourceType: "DsrEvent",
    resourceId: event.id,
    after: event,
  });
  return event;
}
