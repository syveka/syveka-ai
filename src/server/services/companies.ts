import "server-only";

import type { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import { archivedWhere, noteSubject } from "./contacts";
import type { TenantContext } from "@/server/auth/session";
import type { CompanyInput, CompanyListQuery, NoteInput } from "@/lib/validators/crm";

export async function listCompanies(ctx: TenantContext, params: CompanyListQuery) {
  const db = tenantDb(ctx.orgId);
  const where: Prisma.CompanyWhereInput = {
    deletedAt: null,
    ...archivedWhere(params.archived),
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { domain: { contains: params.q, mode: "insensitive" } },
            { industry: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const rows = await db.company.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      _count: {
        select: {
          contacts: { where: { deletedAt: null } },
          deals: { where: { deletedAt: null } },
        },
      },
    },
  });

  const hasMore = rows.length > params.limit;
  const data = hasMore ? rows.slice(0, params.limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1]?.id : undefined };
}

/** Active companies for select inputs (id + name only). */
export async function listCompanyOptions(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.company.findMany({
    where: { deletedAt: null, archivedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
    take: 500,
  });
}

export async function getCompany(ctx: TenantContext, companyId: string) {
  const db = tenantDb(ctx.orgId);
  return db.company.findFirst({
    where: { id: companyId, deletedAt: null },
    include: {
      contacts: {
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 50,
      },
      deals: {
        where: { deletedAt: null },
        include: { stage: true },
        orderBy: { updatedAt: "desc" },
        take: 25,
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          user: { select: { id: true, fullName: true } },
          contact: { select: { id: true, firstName: true, lastName: true } },
        },
      },
    },
  });
}

export async function createCompany(ctx: TenantContext, input: CompanyInput) {
  const db = tenantDb(ctx.orgId);
  const company = await db.company.create({
    data: {
      organizationId: ctx.orgId,
      name: input.name,
      domain: input.domain ?? null,
      industry: input.industry ?? null,
      size: input.size ?? null,
      website: input.website ?? null,
      businessId: input.businessId ?? null,
    },
  });

  await audit(ctx, {
    action: "company.create",
    resourceType: "company",
    resourceId: company.id,
    after: { name: input.name, domain: input.domain },
  });
  return company;
}

export async function updateCompany(ctx: TenantContext, companyId: string, input: CompanyInput) {
  const db = tenantDb(ctx.orgId);
  const before = await db.company.findFirstOrThrow({
    where: { id: companyId, deletedAt: null },
  });

  const company = await db.company.update({
    where: { id: companyId },
    data: {
      name: input.name,
      domain: input.domain ?? null,
      industry: input.industry ?? null,
      size: input.size ?? null,
      website: input.website ?? null,
      businessId: input.businessId ?? null,
    },
  });

  await audit(ctx, {
    action: "company.update",
    resourceType: "company",
    resourceId: companyId,
    before: { name: before.name, domain: before.domain },
    after: { name: input.name, domain: input.domain },
  });
  return company;
}

export async function archiveCompany(ctx: TenantContext, companyId: string) {
  const db = tenantDb(ctx.orgId);
  await db.company.findFirstOrThrow({ where: { id: companyId, deletedAt: null } });
  const company = await db.company.update({
    where: { id: companyId },
    data: { archivedAt: new Date() },
  });
  await audit(ctx, { action: "company.archive", resourceType: "company", resourceId: companyId });
  return company;
}

export async function restoreCompany(ctx: TenantContext, companyId: string) {
  const db = tenantDb(ctx.orgId);
  await db.company.findFirstOrThrow({ where: { id: companyId, deletedAt: null } });
  const company = await db.company.update({
    where: { id: companyId },
    data: { archivedAt: null },
  });
  await audit(ctx, { action: "company.restore", resourceType: "company", resourceId: companyId });
  return company;
}

/**
 * Soft-deletes the company and detaches its remaining contacts so they do not
 * point at a deleted record. Deals keep their historical company reference.
 */
export async function deleteCompany(ctx: TenantContext, companyId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const company = await db.company.findFirstOrThrow({
    where: { id: companyId, deletedAt: null },
  });

  await db.contact.updateMany({
    where: { companyId },
    data: { companyId: null },
  });
  await db.company.update({ where: { id: companyId }, data: { deletedAt: new Date() } });

  await audit(ctx, {
    action: "company.delete",
    resourceType: "company",
    resourceId: companyId,
    before: { name: company.name, domain: company.domain },
  });
}

/** Adds a NOTE activity to the company's timeline. */
export async function addCompanyNote(ctx: TenantContext, companyId: string, input: NoteInput) {
  const db = tenantDb(ctx.orgId);
  const company = await db.company.findFirstOrThrow({
    where: { id: companyId, deletedAt: null },
    select: { id: true },
  });

  const activity = await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      companyId: company.id,
      type: "NOTE",
      subject: noteSubject(input.body),
      body: input.body,
    },
  });

  await audit(ctx, {
    action: "company.note",
    resourceType: "company",
    resourceId: companyId,
    after: { activityId: activity.id },
  });
  return activity;
}
