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

  // Deliberately picked field-by-field rather than `{ ...raw, ... }`. Proven
  // live (staging run 34697153294): a second submission of this
  // useActionState-bound form can arrive as React's own progressive-
  // enhancement fallback fields -- $ACTION_REF_2, $ACTION_2:0, $ACTION_2:1,
  // $ACTION_KEY -- landing inside the same FormData this action receives
  // (confirmed via the business_dna_update_invalid_input diagnostic's
  // unrecognized_keys issue naming exactly those four). Spreading `raw`
  // then passes them straight into businessDnaSchema, which is `.strict()`
  // by design (mass-assignment protection) and rightly rejects them --
  // but this means ANY incidental extra key in `raw`, from this or any
  // other source, fails the whole save. Naming every field explicitly
  // means only genuine form fields ever reach the schema, regardless of
  // what else `raw` happens to contain -- `.strict()` stays exactly as
  // strict as it was, it just never sees framework bookkeeping fields.
  const parsed = businessDnaSchema.safeParse({
    displayName: raw.displayName,
    industry: raw.industry,
    description: raw.description,
    productsServices: raw.productsServices,
    timezone: raw.timezone,
    brandTone: raw.brandTone,
    communicationStyle: raw.communicationStyle,
    responseInstructions: raw.responseInstructions,
    cancellationPolicy: raw.cancellationPolicy,
    bookingPolicy: raw.bookingPolicy,
    refundPolicy: raw.refundPolicy,
    paymentPolicy: raw.paymentPolicy,
    otherPolicies: raw.otherPolicies,
    currency: raw.currency,
    quoteInstructions: raw.quoteInstructions,
    pricingNotes: raw.pricingNotes,
    targetCustomer: raw.targetCustomer,
    sourceUrl: raw.sourceUrl,
    supportedLocales: formData.getAll("supportedLocales"),
    keyFacts: formData
      .getAll("keyFacts")
      .flatMap((v) => String(v).split("\n"))
      .map((v) => v.trim())
      .filter(Boolean),
    openingHours,
  });
  if (!parsed.success) {
    // Non-sensitive: field names/paths and zod issue codes only, never the
    // submitted values or zod's own `.message` text (some built-in zod
    // messages, e.g. enum mismatches, echo the rejected value verbatim --
    // `code`/`path` never do). This schema is .strict(), so a re-submit
    // whose shape has drifted (stale client state after a save +
    // revalidation, an extra/renamed field) fails as a root-level
    // "unrecognized_keys" issue with an EMPTY path -- proven live
    // (2026-09-12, staging run 34694851185): logging only
    // `Object.keys(flatten().fieldErrors)` reports `[]` for exactly this
    // case, because zod's flatten() buckets any issue with an empty path
    // into `formErrors`, not `fieldErrors`, hiding the one detail
    // (`unrecognized_keys`'s `keys` list) that would name the actual field.
    // Logging every issue's code/path (and, only for unrecognized_keys, the
    // offending key names -- safe, since those are field *names* the client
    // sent, never their values) closes that gap. Same rationale as
    // session.ts's get_session_user_error/get_tenant_context_or_null_unexpected_error
    // diagnostics.
    console.error(
      JSON.stringify({
        event: "business_dna_update_invalid_input",
        orgId: ctx.orgId,
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          ...(issue.code === "unrecognized_keys" ? { keys: issue.keys } : {}),
        })),
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
