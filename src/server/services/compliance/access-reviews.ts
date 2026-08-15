import "server-only";

import type { AccessReviewScope } from "@prisma/client";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { complianceAudit } from "./audit";

export async function listAccessReviews() {
  await requireSuperadmin();
  return unscopedPrisma.accessReview.findMany({ orderBy: { performedAt: "desc" } });
}

export type RecordAccessReviewInput = {
  reviewKey: string;
  scope: AccessReviewScope;
  performedAt: Date;
  findingsSummary: string;
  staleAccessFound?: boolean;
  actionsTaken?: string;
  nextReviewDueAt?: Date;
};

/**
 * Records evidence that a periodic access review happened. Does not itself
 * grant/revoke access -- it reuses existing RBAC/superadmin data as the
 * subject of review, never a parallel authorization system.
 */
export async function recordAccessReview(input: RecordAccessReviewInput) {
  const { userId } = await requireSuperadmin();
  const review = await unscopedPrisma.accessReview.create({
    data: { performedByUserId: userId, ...input },
  });
  await complianceAudit(userId, {
    action: "access_review.create",
    resourceType: "AccessReview",
    resourceId: review.id,
    after: review,
  });
  return review;
}

/** Current privileged accounts, as the subject of a review -- read-only, reuses existing auth data. */
export async function listPrivilegedAccountsForReview() {
  await requireSuperadmin();
  const [orgOwnersAndAdmins, apiKeys] = await Promise.all([
    unscopedPrisma.organizationMember.findMany({
      where: { role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true, organizationId: true, role: true },
    }),
    unscopedPrisma.apiKey.findMany({
      select: { id: true, organizationId: true, name: true, createdAt: true, lastUsedAt: true },
    }),
  ]);
  return { orgOwnersAndAdmins, apiKeys };
}
