"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { getBusinessDNA, upsertBusinessDNA } from "@/server/services/business-dna";
import { businessDnaSchema } from "@/lib/validators/business-dna";

export type BusinessDnaActionState = { error?: string; message?: string };

export async function getBusinessDnaAction() {
  const ctx = await requirePermission("business-dna:read");
  return getBusinessDNA(ctx);
}

export async function updateBusinessDnaAction(
  _prev: BusinessDnaActionState,
  formData: FormData,
): Promise<BusinessDnaActionState> {
  const ctx = await requirePermission("business-dna:write");

  const raw = Object.fromEntries(formData);
  let openingHours: unknown;
  if (raw.openingHours) {
    try {
      openingHours = JSON.parse(String(raw.openingHours));
    } catch {
      return { error: "invalid_input" };
    }
  }

  const parsed = businessDnaSchema.safeParse({
    ...raw,
    supportedLocales: formData.getAll("supportedLocales"),
    keyFacts: formData
      .getAll("keyFacts")
      .flatMap((v) => String(v).split("\n"))
      .map((v) => v.trim())
      .filter(Boolean),
    openingHours,
  });
  if (!parsed.success) {
    // Non-sensitive: field names only, never the submitted values -- this
    // schema is .strict(), so a re-submit of a page that's drifted from the
    // form's expected shape (stale client state after a save + revalidation,
    // an extra/renamed field) fails here with zero visibility into which
    // field caused it, indistinguishable from a genuine user typo. Same
    // rationale as session.ts's get_session_user_error/
    // get_tenant_context_or_null_unexpected_error diagnostics.
    console.error(
      JSON.stringify({
        event: "business_dna_update_invalid_input",
        orgId: ctx.orgId,
        fieldErrors: Object.keys(parsed.error.flatten().fieldErrors),
      }),
    );
    return { error: "invalid_input" };
  }

  try {
    await upsertBusinessDNA(ctx, parsed.data);
  } catch {
    return { error: "failed" };
  }
  revalidatePath("/settings/business-dna");
  return { message: "saved" };
}
