import "server-only";

import type { Locale } from "@prisma/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { slugify } from "@/lib/utils";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import { audit } from "./audit";

/**
 * Creates an Organization with everything a tenant needs (§11.3):
 * OWNER membership, FREE subscription, default Finnish pipeline.
 * Sets last_active_org in app_metadata so the token hook injects claims.
 */
export async function createOrganization(params: {
  userId: string;
  name: string;
  businessId?: string;
  industry?: string;
  defaultLocale: Locale;
}) {
  const base = slugify(params.name) || "org";
  let slug = base;
  for (let i = 0; ; i++) {
    const exists = await unscopedPrisma.organization.findUnique({ where: { slug } });
    if (!exists) break;
    slug = `${base}-${i + 2}`;
  }

  const org = await unscopedPrisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: params.name,
        slug,
        businessId: params.businessId || null,
        defaultLocale: params.defaultLocale,
        settings: params.industry ? { industry: params.industry } : {},
      },
    });

    await tx.organizationMember.create({
      data: { organizationId: org.id, userId: params.userId, role: "OWNER" },
    });

    await tx.subscription.create({
      data: { organizationId: org.id, plan: "FREE", status: "ACTIVE", seats: 1 },
    });

    await tx.pipeline.create({
      data: {
        organizationId: org.id,
        name: "Myyntiputki",
        isDefault: true,
        stages: { create: DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })) },
      },
    });

    return org;
  });

  // Activate org in the JWT via app_metadata (§6.3) — next token refresh
  // carries org_id + role claims.
  const admin = createSupabaseAdmin();
  await admin.auth.admin.updateUserById(params.userId, {
    app_metadata: { last_active_org: org.id },
  });

  await unscopedPrisma.user.update({
    where: { id: params.userId },
    data: { onboardedAt: new Date() },
  });

  await audit(
    { orgId: org.id, userId: params.userId },
    { action: "org.create", resourceType: "organization", resourceId: org.id },
  );

  return org;
}

/** Verifies membership, then switches the active org claim (§11.3). */
export async function switchOrganization(userId: string, orgId: string): Promise<void> {
  const membership = await unscopedPrisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
  });
  if (!membership) throw new Error("Not a member of this organization");

  const admin = createSupabaseAdmin();
  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { last_active_org: orgId },
  });
}
