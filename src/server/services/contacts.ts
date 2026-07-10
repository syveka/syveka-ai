import "server-only";

import type { ContactStatus, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant";
import { assertWithinLimit } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { ContactInput } from "@/lib/validators/crm";

export async function listContacts(
  ctx: TenantContext,
  params: { q?: string; status?: ContactStatus; cursor?: string; limit: number },
) {
  const db = tenantDb(ctx.orgId);
  const where: Prisma.ContactWhereInput = {
    deletedAt: null,
    ...(params.status ? { status: params.status } : {}),
    ...(params.q
      ? {
          OR: [
            { firstName: { contains: params.q, mode: "insensitive" } },
            { lastName: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
            { phone: { contains: params.q.replace(/\s/g, "") } },
          ],
        }
      : {}),
  };

  const rows = await db.contact.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      company: { select: { id: true, name: true } },
      tags: { include: { tag: { select: { name: true, color: true } } } },
    },
  });

  const hasMore = rows.length > params.limit;
  const data = hasMore ? rows.slice(0, params.limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1]?.id : undefined };
}

export async function getContact(ctx: TenantContext, contactId: string) {
  const db = tenantDb(ctx.orgId);
  return db.contact.findFirst({
    where: { id: contactId, deletedAt: null },
    include: {
      company: true,
      deals: { where: { deletedAt: null }, include: { stage: true } },
      activities: { orderBy: { createdAt: "desc" }, take: 30 },
      tags: { include: { tag: true } },
    },
  });
}

export async function createContact(ctx: TenantContext, input: ContactInput) {
  const db = tenantDb(ctx.orgId);
  const current = await db.contact.count({ where: { deletedAt: null } });
  await assertWithinLimit(ctx.orgId, { kind: "contacts", current });

  const contact = await db.contact.create({
    data: {
      organizationId: ctx.orgId,
      firstName: input.firstName,
      lastName: input.lastName || null,
      email: input.email || null,
      phone: input.phone || null,
      title: input.title || null,
      companyId: input.companyId,
      status: input.status,
      ownerId: ctx.userId,
      source: "manual",
      gdprConsentAt: input.gdprConsent ? new Date() : null,
    },
  });

  await audit(ctx, {
    action: "contact.create",
    resourceType: "contact",
    resourceId: contact.id,
    after: { firstName: input.firstName, email: input.email },
  });
  return contact;
}

export async function updateContact(ctx: TenantContext, contactId: string, input: ContactInput) {
  const db = tenantDb(ctx.orgId);
  const before = await db.contact.findFirstOrThrow({ where: { id: contactId } });

  const contact = await db.contact.update({
    where: { id: contactId },
    data: {
      firstName: input.firstName,
      lastName: input.lastName || null,
      email: input.email || null,
      phone: input.phone || null,
      title: input.title || null,
      companyId: input.companyId,
      status: input.status,
    },
  });

  await audit(ctx, {
    action: "contact.update",
    resourceType: "contact",
    resourceId: contactId,
    before: { status: before.status, email: before.email },
    after: { status: input.status, email: input.email },
  });
  return contact;
}

export async function deleteContact(ctx: TenantContext, contactId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const contact = await db.contact.findFirstOrThrow({ where: { id: contactId } });
  await db.contact.update({ where: { id: contactId }, data: { deletedAt: new Date() } });
  await audit(ctx, {
    action: "contact.delete",
    resourceType: "contact",
    resourceId: contactId,
    before: { firstName: contact.firstName, email: contact.email },
  });
}
