import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { assertFeatureEnabled } from "./feature-flags";
import { CREATOR_STUDIO_FLAG } from "./creator-profiles";

/** Phase 8: global (organizationId null) + org templates, merged — same pattern as prompts.ts (§15.7). */
export async function listCreatorTemplates(ctx: TenantContext, category?: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return unscopedPrisma.creatorTemplate.findMany({
    where: {
      active: true,
      OR: [{ organizationId: null }, { organizationId: ctx.orgId }],
      ...(category ? { category } : {}),
    },
    orderBy: [{ organizationId: { sort: "desc", nulls: "last" } }, { name: "asc" }],
    take: 200,
  });
}

export async function getCreatorTemplate(ctx: TenantContext, id: string) {
  await assertFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);
  return unscopedPrisma.creatorTemplate.findFirstOrThrow({
    where: { id, OR: [{ organizationId: null }, { organizationId: ctx.orgId }] },
  });
}
