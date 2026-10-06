"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Locale } from "@/generated/prisma/client/client";
import { getSessionUser } from "@/server/auth/session";
import { AuthError } from "@/server/auth/session";
import {
  countMemberships,
  createOrganization,
  switchOrganization,
} from "@/server/services/organizations";
import { createSupabaseServer } from "@/server/supabase/server";
import { createOrgSchema } from "@/lib/validators/organization";

export type OrgActionState = { error?: string };

export async function createOrganizationAction(
  _prev: OrgActionState,
  formData: FormData,
): Promise<OrgActionState> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated");

  const parsed = createOrgSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  const membershipsBefore = await countMemberships(user.id).catch(() => null);
  try {
    await createOrganization({
      userId: user.id,
      name: parsed.data.name,
      businessId: parsed.data.businessId || undefined,
      industry: parsed.data.industry,
      defaultLocale: parsed.data.defaultLocale as Locale,
    });
  } catch (error) {
    // The org/membership transaction is atomic, but the steps after it (JWT
    // claim, onboardedAt) are not. If the org was already committed, carry on:
    // returning an error here would invite a retry that creates a duplicate
    // org. Otherwise show the form's own error instead of a crash page. Only
    // the error name is logged -- Prisma messages can echo connection details.
    console.error(
      JSON.stringify({
        event: "create_organization_failed",
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    const membershipsAfter =
      membershipsBefore === null ? null : await countMemberships(user.id).catch(() => null);
    const orgWasCommitted =
      membershipsBefore !== null &&
      membershipsAfter !== null &&
      membershipsAfter > membershipsBefore;
    if (!orgWasCommitted) return { error: "create_failed" };
  }

  // Refresh session so the new org_id/role claims are in the JWT
  const supabase = await createSupabaseServer();
  await supabase.auth.refreshSession();

  // A brand-new org has no Business DNA yet — send the owner there first
  // (skippable) rather than straight to an empty dashboard.
  redirect("/settings/business-dna");
}

export async function switchOrganizationAction(orgId: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated");

  await switchOrganization(user.id, orgId);

  const supabase = await createSupabaseServer();
  await supabase.auth.refreshSession();

  revalidatePath("/", "layout");
  redirect("/dashboard");
}
