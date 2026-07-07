"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Locale } from "@prisma/client";
import { getSessionUser } from "@/server/auth/session";
import { AuthError } from "@/server/auth/session";
import { createOrganization, switchOrganization } from "@/server/services/organizations";
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

  await createOrganization({
    userId: user.id,
    name: parsed.data.name,
    businessId: parsed.data.businessId || undefined,
    industry: parsed.data.industry,
    defaultLocale: parsed.data.defaultLocale as Locale,
  });

  // Refresh session so the new org_id/role claims are in the JWT
  const supabase = await createSupabaseServer();
  await supabase.auth.refreshSession();

  redirect("/dashboard");
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
