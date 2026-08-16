import "server-only";

import { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDNAInput } from "@/lib/validators/business-dna";

/** One profile per organization. Returns null until first saved. */
export async function getBusinessDNA(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.businessDNA.findFirst({});
}

/**
 * Deterministic create-or-replace on the org's singleton profile.
 * `sourceUrl` presence re-stamps `extractedAt`; its absence clears both,
 * so provenance always reflects the data currently on record.
 */
export async function upsertBusinessDNA(ctx: TenantContext, input: BusinessDNAInput) {
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

  const existing = await db.businessDNA.findFirst({ select: { id: true } });
  const record = existing
    ? await db.businessDNA.update({ where: { id: existing.id }, data: shared })
    : await db.businessDNA.create({ data: { organizationId: ctx.orgId, ...shared } });

  await audit(ctx, {
    action: existing ? "business_dna.update" : "business_dna.create",
    resourceType: "business_dna",
    resourceId: record.id,
  });

  return record;
}
