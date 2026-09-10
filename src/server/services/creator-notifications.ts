import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import type { Role } from "@prisma/client";

/**
 * Creator Studio in-app notifications — direct `notification.create` calls,
 * same convention as every other job/service in this codebase (there is no
 * shared notification-dispatch helper to reuse; see e.g.
 * src/app/api/v1/jobs/run-workflow/route.ts's notify.member step).
 */

const APPROVER_ROLES: Role[] = ["OWNER", "ADMIN", "MANAGER"];

/** Notify every member able to approve content (Phase 21: "content is ready for approval"). */
export async function notifyApprovers(
  ctx: Pick<TenantContext, "orgId">,
  params: { type: string; title: string; href?: string },
): Promise<void> {
  const approvers = await unscopedPrisma.organizationMember.findMany({
    where: { organizationId: ctx.orgId, role: { in: APPROVER_ROLES } },
    select: { userId: true },
    take: 25,
  });
  if (approvers.length === 0) return;
  await unscopedPrisma.notification.createMany({
    data: approvers.map((a) => ({
      organizationId: ctx.orgId,
      userId: a.userId,
      type: params.type,
      title: params.title,
      href: params.href,
    })),
  });
}

/** Notify one specific user (e.g. the post's author about an approval decision). */
export async function notifyUser(
  ctx: Pick<TenantContext, "orgId">,
  userId: string,
  params: { type: string; title: string; body?: string; href?: string },
): Promise<void> {
  await unscopedPrisma.notification.create({
    data: {
      organizationId: ctx.orgId,
      userId,
      type: params.type,
      title: params.title,
      body: params.body,
      href: params.href,
    },
  });
}
