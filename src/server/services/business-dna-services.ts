import "server-only";

import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { BusinessDnaServiceInput } from "@/lib/validators/business-dna";

/** All services for the org, active first, in display order. Tenant identity comes only from `ctx`. */
export async function listBusinessDnaServices(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.businessDnaService.findMany({
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

/**
 * Creates one product/service line item under the org's Business DNA
 * profile. The profile must already exist -- Company identity comes first
 * in the intended UI flow, and a service with no parent profile has nowhere
 * meaningful to attach.
 */
export async function createBusinessDnaService(ctx: TenantContext, input: BusinessDnaServiceInput) {
  const db = tenantDb(ctx.orgId);
  const profile = await db.businessDNA.findFirst({ select: { id: true } });
  if (!profile) {
    throw new Error("Business DNA profile must be created before adding services");
  }

  const service = await db.businessDnaService.create({
    data: {
      organizationId: ctx.orgId,
      businessDnaId: profile.id,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents ?? null,
      priceNote: input.priceNote ?? null,
      durationMinutes: input.durationMinutes ?? null,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    },
  });

  await audit(ctx, {
    action: "business_dna_service.create",
    resourceType: "business_dna_service",
    resourceId: service.id,
  });

  return service;
}

/**
 * Updates a service by id, scoped to the caller's tenant via `tenantDb`.
 * `tenantDb` injects `organizationId` into the `where` clause, so an id
 * belonging to another organization matches zero rows and this throws
 * Prisma's standard "record not found" error rather than silently updating
 * (or leaking the existence of) another tenant's row.
 */
export async function updateBusinessDnaService(
  ctx: TenantContext,
  id: string,
  input: Partial<BusinessDnaServiceInput>,
) {
  const db = tenantDb(ctx.orgId);
  const before = await db.businessDnaService.findFirst({ where: { id } });
  if (!before) {
    throw new Error("Service not found");
  }

  const service = await db.businessDnaService.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description ?? null }),
      ...(input.priceCents !== undefined && { priceCents: input.priceCents ?? null }),
      ...(input.priceNote !== undefined && { priceNote: input.priceNote ?? null }),
      ...(input.durationMinutes !== undefined && {
        durationMinutes: input.durationMinutes ?? null,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
    },
  });

  await audit(ctx, {
    action: "business_dna_service.update",
    resourceType: "business_dna_service",
    resourceId: service.id,
  });

  return service;
}

/**
 * Deactivates (never hard-deletes) a service by id. Deactivation, not
 * deletion, keeps history intact for records that may be referenced
 * elsewhere (Booking integrations, prior quotes/prompts) -- the same
 * soft-state convention as `WebhookEndpoint.isActive`/`ApiKey.revokedAt`
 * rather than destroying rows outright. `tenantDb` scoping gives the same
 * cross-tenant protection as `updateBusinessDnaService`.
 */
export async function deactivateBusinessDnaService(ctx: TenantContext, id: string) {
  const db = tenantDb(ctx.orgId);
  const before = await db.businessDnaService.findFirst({ where: { id } });
  if (!before) {
    throw new Error("Service not found");
  }

  const service = await db.businessDnaService.update({
    where: { id },
    data: { isActive: false },
  });

  await audit(ctx, {
    action: "business_dna_service.deactivate",
    resourceType: "business_dna_service",
    resourceId: service.id,
  });

  return service;
}

/** Reactivates a previously deactivated service by id. Same tenant-scoping guarantee as the other mutations. */
export async function reactivateBusinessDnaService(ctx: TenantContext, id: string) {
  const db = tenantDb(ctx.orgId);
  const before = await db.businessDnaService.findFirst({ where: { id } });
  if (!before) {
    throw new Error("Service not found");
  }

  const service = await db.businessDnaService.update({
    where: { id },
    data: { isActive: true },
  });

  await audit(ctx, {
    action: "business_dna_service.reactivate",
    resourceType: "business_dna_service",
    resourceId: service.id,
  });

  return service;
}
