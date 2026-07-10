import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { tenantDb } from "@/server/db/tenant";
import { getEntitlements } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";

export const API_SCOPES = [
  "crm:read", "crm:write", "chat:write", "kb:read", "kb:write",
  "calendar:read", "calendar:write", "analytics:read",
] as const;

export async function listApiKeys(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.apiKey.findMany({
    where: { revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
  });
}

/** Returns the plaintext key exactly once (§10.2). */
export async function createApiKey(
  ctx: TenantContext,
  input: { name: string; scopes: string[] },
): Promise<{ plaintext: string }> {
  const ent = await getEntitlements(ctx.orgId);
  if (!ent.apiAccess) throw new Error("API access requires the PRO plan");

  const secret = randomBytes(24).toString("base64url");
  const plaintext = `syv_live_${secret}`;
  const keyHash = createHash("sha256").update(plaintext).digest("hex");

  const db = tenantDb(ctx.orgId);
  await db.apiKey.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      keyHash,
      prefix: plaintext.slice(0, 13),
      scopes: input.scopes.filter((s) => (API_SCOPES as readonly string[]).includes(s)),
    },
  });

  await audit(ctx, {
    action: "api_key.create",
    resourceType: "api_key",
    after: { name: input.name, scopes: input.scopes },
  });
  return { plaintext };
}

export async function revokeApiKey(ctx: TenantContext, keyId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  await db.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  await audit(ctx, { action: "api_key.revoke", resourceType: "api_key", resourceId: keyId });
}

/** Bearer-token resolution for public API routes (§10.1). */
export async function resolveApiKey(plaintext: string) {
  const { unscopedPrisma } = await import("@/server/db/tenant");
  const keyHash = createHash("sha256").update(plaintext).digest("hex");
  const key = await unscopedPrisma.apiKey.findUnique({ where: { keyHash } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;
  void unscopedPrisma.apiKey
    .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
  return { orgId: key.organizationId, scopes: key.scopes, keyId: key.id };
}
