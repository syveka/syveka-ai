import "server-only";

import { headers } from "next/headers";
import { unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";

type AuditInput = {
  action: string; // "contact.update", "member.role_change", ...
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  actorType?: "user" | "api_key" | "system" | "voice_ai";
};

export type { AuditInput };

/**
 * The audit row for an action, including the request's IP and user agent
 * when there is a request. For writes that must be recorded in the same
 * transaction as the change they describe.
 */
export async function auditLogData(
  ctx: Pick<TenantContext, "orgId" | "userId">,
  input: AuditInput,
) {
  let ip: string | undefined;
  let userAgent: string | undefined;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
    userAgent = h.get("user-agent") ?? undefined;
  } catch {
    // jobs/webhooks have no request headers
  }
  return {
    organizationId: ctx.orgId,
    actorId: input.actorType === "system" ? null : ctx.userId,
    actorType: input.actorType ?? "user",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    before: input.before === undefined ? undefined : (input.before as object),
    after: input.after === undefined ? undefined : (input.after as object),
    ip,
    userAgent,
  };
}

/** Append-only audit trail (§5.3). Never throws into the caller's flow. */
export async function audit(
  ctx: Pick<TenantContext, "orgId" | "userId">,
  input: AuditInput,
): Promise<void> {
  await unscopedPrisma.auditLog.create({ data: await auditLogData(ctx, input) });
}
