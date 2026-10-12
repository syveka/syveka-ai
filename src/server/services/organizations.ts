import "server-only";

import type { Locale } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { slugify } from "@/lib/utils";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import { audit } from "./audit";

/**
 * Creates an Organization with everything a tenant needs (§11.3):
 * OWNER membership, FREE subscription, default Finnish pipeline.
 * Sets last_active_org in app_metadata so the token hook injects claims.
 *
 * An industry given at onboarding goes straight into the org's Business DNA
 * (the shared business context every assistant and module reads), in the
 * same transaction: the org and its profile are created together or not at
 * all, so the owner is never asked for it again. It is not also copied into
 * `settings`, which nothing lets the owner edit and which would drift from
 * the profile.
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

  const industry = params.industry?.trim() || null;

  const { org, businessDnaId } = await unscopedPrisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: params.name,
        slug,
        businessId: params.businessId || null,
        defaultLocale: params.defaultLocale,
        settings: {},
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

    const businessDna = industry
      ? await tx.businessDNA.create({
          data: { organizationId: org.id, industry },
          select: { id: true },
        })
      : null;

    return { org, businessDnaId: businessDna?.id ?? null };
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
  if (businessDnaId) {
    await audit(
      { orgId: org.id, userId: params.userId },
      { action: "business_dna.create", resourceType: "business_dna", resourceId: businessDnaId },
    );
  }

  return org;
}

/** Number of organization memberships the user holds (any role, any org state). */
export async function countMemberships(userId: string): Promise<number> {
  return unscopedPrisma.organizationMember.count({ where: { userId } });
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
