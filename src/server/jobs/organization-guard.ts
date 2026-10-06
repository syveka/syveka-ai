import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";

/**
 * Whether a job may act for this organization: it exists and isn't
 * soft-deleted. Jobs check it before any external or business effect
 * (publishing, email, paid AI, embeddings) and again before persisting the
 * result of a long provider call.
 *
 * A database error is thrown, not reported as "inactive": the job fails and
 * the queue retries it. Only a definite answer turns into a skip.
 *
 * This narrows, but can't close, the window between the check and an
 * external call: an organization deleted after the check but while the call
 * is in flight still gets that one call, which can't be recalled.
 */
export async function isOrganizationActive(orgId: string): Promise<boolean> {
  const org = await unscopedPrisma.organization.findFirst({
    where: { id: orgId, deletedAt: null },
    select: { id: true },
  });
  return org !== null;
}

/** Response body for a job skipped because its organization is gone or deleted (HTTP 200, no retry). */
export const ORGANIZATION_INACTIVE = { skipped: "organization_inactive" } as const;
