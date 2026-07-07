import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";

export async function listNotifications(ctx: TenantContext, unreadOnly = false) {
  const db = tenantDb(ctx.orgId);
  return db.notification.findMany({
    where: { userId: ctx.userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function unreadCount(ctx: TenantContext): Promise<number> {
  const db = tenantDb(ctx.orgId);
  return db.notification.count({ where: { userId: ctx.userId, readAt: null } });
}

export async function markRead(ctx: TenantContext, ids: string[] | "all"): Promise<void> {
  const db = tenantDb(ctx.orgId);
  await db.notification.updateMany({
    where: { userId: ctx.userId, readAt: null, ...(ids === "all" ? {} : { id: { in: ids } }) },
    data: { readAt: new Date() },
  });
}
