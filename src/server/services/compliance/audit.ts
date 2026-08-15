import "server-only";

import { headers } from "next/headers";
import { unscopedPrisma } from "@/server/db/tenant";

type ComplianceAuditInput = {
  action: string; // "compliance_control.update", "security_incident.create", ...
  resourceType: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  actorType?: "user" | "system";
};

/**
 * Append-only audit trail for the Syveka-platform-level compliance domain
 * (Issue #74). Parallel to `src/server/services/audit.ts`'s `audit()`, minus
 * `orgId` -- these actions have no tenant to attribute to. See
 * docs/compliance/ARCHITECTURE.md for why this is a dedicated table rather
 * than a reuse of `AuditLog`. Never throws into the caller's flow.
 */
export async function complianceAudit(
  actorUserId: string | null,
  input: ComplianceAuditInput,
): Promise<void> {
  let ip: string | undefined;
  let userAgent: string | undefined;
  try {
    const h = await headers();
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
    userAgent = h.get("user-agent") ?? undefined;
  } catch {
    // jobs/webhooks have no request headers
  }

  await unscopedPrisma.complianceAuditLog.create({
    data: {
      actorUserId: input.actorType === "system" ? null : actorUserId,
      actorType: input.actorType ?? "user",
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: input.before === undefined ? undefined : (input.before as object),
      after: input.after === undefined ? undefined : (input.after as object),
      ip,
      userAgent,
    },
  });
}
