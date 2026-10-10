import "server-only";

import { Prisma } from "@/generated/prisma/client/client";
import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import { resyncActiveAssistants } from "./voice";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput } from "@/lib/validators/business-dna";

/** One profile per organization. Returns null until first saved. */
export async function getBusinessDNA(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.businessDNA.findFirst({});
}

export type UpsertBusinessDnaResult =
  | { ok: true; record: NonNullable<Awaited<ReturnType<typeof getBusinessDNA>>> }
  /** The profile changed since the caller loaded it (or now exists): nothing was saved. */
  | { ok: false; reason: "conflict" };

/**
 * Deterministic create-or-replace on the org's singleton profile, only if it
 * is still the version the caller loaded: `expectedUpdatedAt` is the
 * profile's `updatedAt` as loaded, or null when there was no profile yet.
 * `sourceUrl` presence re-stamps `extractedAt`; its absence clears both,
 * so provenance always reflects the data currently on record.
 */
export async function upsertBusinessDNA(
  ctx: TenantContext,
  input: BusinessDNAInput,
  expectedUpdatedAt: string | null,
): Promise<UpsertBusinessDnaResult> {
  const db = tenantDb(ctx.orgId);
  const shared = {
    displayName: input.displayName ?? null,
    industry: input.industry ?? null,
    description: input.description ?? null,
    productsServices: input.productsServices ?? null,
    supportedLocales: input.supportedLocales,
    timezone: input.timezone ?? null,
    brandTone: input.brandTone ?? null,
    communicationStyle: input.communicationStyle ?? null,
    responseInstructions: input.responseInstructions ?? null,
    openingHours: input.openingHours ?? Prisma.JsonNull,
    cancellationPolicy: input.cancellationPolicy ?? null,
    bookingPolicy: input.bookingPolicy ?? null,
    refundPolicy: input.refundPolicy ?? null,
    paymentPolicy: input.paymentPolicy ?? null,
    otherPolicies: input.otherPolicies ?? null,
    currency: input.currency ?? null,
    quoteInstructions: input.quoteInstructions ?? null,
    pricingNotes: input.pricingNotes ?? null,
    targetCustomer: input.targetCustomer ?? null,
    keyFacts: input.keyFacts,
    sourceUrl: input.sourceUrl ?? null,
    extractedAt: input.sourceUrl ? new Date() : null,
  };

  // Compare-and-set in one statement: only the version the user loaded is
  // replaced. A save from a stale form (the profile was changed since, in
  // chat or another tab) updates nothing. While a chat change holds the row
  // lock, this UPDATE waits and then re-checks updated_at against the
  // committed row (see applyBusinessDnaPatch).
  let record;
  if (expectedUpdatedAt) {
    const savedAt = new Date();
    const { count } = await db.businessDNA.updateMany({
      where: { updatedAt: new Date(expectedUpdatedAt) },
      data: { ...shared, updatedAt: savedAt },
    });
    if (count === 0) return { ok: false, reason: "conflict" };
    const current = await db.businessDNA.findFirst({});
    if (!current) return { ok: false, reason: "conflict" };
    // Exactly what this save wrote, at the version it wrote -- even if
    // another change landed right after it (before this read): the caller's
    // next save must then conflict rather than replace a change it never saw.
    // (openingHours: the stored value, not Prisma's JsonNull write sentinel.)
    record = {
      ...current,
      ...shared,
      openingHours: input.openingHours ?? null,
      updatedAt: savedAt,
    };
  } else {
    try {
      record = await db.businessDNA.create({ data: { organizationId: ctx.orgId, ...shared } });
    } catch (e) {
      // The form was opened before any profile existed, and one was created since.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return { ok: false, reason: "conflict" };
      }
      throw e;
    }
  }

  await audit(ctx, {
    action: expectedUpdatedAt ? "business_dna.update" : "business_dna.create",
    resourceType: "business_dna",
    resourceId: record.id,
  });

  // A live voice assistant must not keep quoting stale pricing/policy/hours
  // after this save - see resyncActiveAssistants' doc comment. Best-effort:
  // this save has already committed by this point, so a Vapi-side failure
  // here is logged, never surfaced as a failure of the Business DNA save.
  await resyncActiveAssistants(ctx.orgId);

  return { ok: true, record };
}
