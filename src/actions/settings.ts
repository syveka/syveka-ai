"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTenantContext } from "@/server/auth/session";
import { requirePermission } from "@/server/auth/guard";
import { unscopedPrisma } from "@/server/db/tenant";
import { audit } from "@/server/services/audit";

export type SettingsActionState = { error?: string; message?: string };

const profileSchema = z.object({
  fullName: z.string().min(1).max(120),
  locale: z.enum(["EN", "FI", "AR"]),
  timezone: z.string().min(1).max(64),
});

export async function updateProfileAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const ctx = await getTenantContext();
  const parsed = profileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  await unscopedPrisma.user.update({
    where: { id: ctx.userId },
    data: parsed.data,
  });
  revalidatePath("/settings/profile");
  return { message: "saved" };
}

const orgSchema = z.object({
  name: z.string().min(2).max(120),
  businessId: z.string().regex(/^\d{7}-\d$/).optional().or(z.literal("")),
  vatId: z.string().max(20).optional().or(z.literal("")),
  aiInstructions: z.string().max(2000).optional().or(z.literal("")),
});

export async function updateOrganizationAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const ctx = await requirePermission("org:update");
  const parsed = orgSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  const before = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { name: true, settings: true },
  });

  await unscopedPrisma.organization.update({
    where: { id: ctx.orgId },
    data: {
      name: parsed.data.name,
      businessId: parsed.data.businessId || null,
      vatId: parsed.data.vatId || null,
      settings: {
        ...(before.settings as object),
        aiInstructions: parsed.data.aiInstructions || undefined,
      },
    },
  });

  await audit(ctx, {
    action: "org.update",
    resourceType: "organization",
    resourceId: ctx.orgId,
    before: { name: before.name },
    after: { name: parsed.data.name },
  });

  revalidatePath("/settings/organization");
  revalidatePath("/", "layout");
  return { message: "saved" };
}
