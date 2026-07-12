import "server-only";

import type { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/db/tenant";
import { assertWithinLimit } from "./billing/entitlements";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type {
  ArchivedFilter,
  ContactInput,
  ContactListQuery,
  NoteInput,
} from "@/lib/validators/crm";

/** Shared archive filter → Prisma where fragment. Defaults to active records. */
export function archivedWhere(filter?: ArchivedFilter): { archivedAt?: null | { not: null } } {
  if (filter === "archived") return { archivedAt: { not: null } };
  if (filter === "all") return {};
  return { archivedAt: null };
}

/** First line of a note, truncated for the activity subject column. */
export function noteSubject(body: string, max = 120): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

export async function listContacts(ctx: TenantContext, params: ContactListQuery) {
  const db = tenantDb(ctx.orgId);
  const where: Prisma.ContactWhereInput = {
    deletedAt: null,
    ...archivedWhere(params.archived),
    ...(params.status ? { status: params.status } : {}),
    ...(params.companyId ? { companyId: params.companyId } : {}),
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
      company: { select: { id: true, name: true, archivedAt: true, deletedAt: true } },
      deals: { where: { deletedAt: null }, include: { stage: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: { select: { id: true, fullName: true } } },
      },
      tags: { include: { tag: true } },
    },
  });
}

/** Throws if the company is missing, deleted, or belongs to another tenant. */
async function assertCompanyInTenant(db: ReturnType<typeof tenantDb>, companyId: string) {
  await db.company.findFirstOrThrow({
    where: { id: companyId, deletedAt: null },
    select: { id: true },
  });
}

export async function createContact(ctx: TenantContext, input: ContactInput) {
  const db = tenantDb(ctx.orgId);
  const current = await db.contact.count({ where: { deletedAt: null } });
  await assertWithinLimit(ctx.orgId, { kind: "contacts", current });
  if (input.companyId) await assertCompanyInTenant(db, input.companyId);

  const contact = await db.contact.create({
    data: {
      organizationId: ctx.orgId,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      title: input.title ?? null,
      companyId: input.companyId ?? null,
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
  const before = await db.contact.findFirstOrThrow({
    where: { id: contactId, deletedAt: null },
  });
  if (input.companyId) await assertCompanyInTenant(db, input.companyId);

  const contact = await db.contact.update({
    where: { id: contactId },
    data: {
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      title: input.title ?? null,
      companyId: input.companyId ?? null,
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

export async function archiveContact(ctx: TenantContext, contactId: string) {
  const db = tenantDb(ctx.orgId);
  await db.contact.findFirstOrThrow({ where: { id: contactId, deletedAt: null } });
  const contact = await db.contact.update({
    where: { id: contactId },
    data: { archivedAt: new Date() },
  });
  await audit(ctx, { action: "contact.archive", resourceType: "contact", resourceId: contactId });
  return contact;
}

export async function restoreContact(ctx: TenantContext, contactId: string) {
  const db = tenantDb(ctx.orgId);
  await db.contact.findFirstOrThrow({ where: { id: contactId, deletedAt: null } });
  const contact = await db.contact.update({
    where: { id: contactId },
    data: { archivedAt: null },
  });
  await audit(ctx, { action: "contact.restore", resourceType: "contact", resourceId: contactId });
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

/** Adds a NOTE activity to the contact's timeline (and its company's, if linked). */
export async function addContactNote(ctx: TenantContext, contactId: string, input: NoteInput) {
  const db = tenantDb(ctx.orgId);
  const contact = await db.contact.findFirstOrThrow({
    where: { id: contactId, deletedAt: null },
    select: { id: true, companyId: true },
  });

  const activity = await db.activity.create({
    data: {
      organizationId: ctx.orgId,
      userId: ctx.userId,
      contactId: contact.id,
      companyId: contact.companyId,
      type: "NOTE",
      subject: noteSubject(input.body),
      body: input.body,
    },
  });

  await audit(ctx, {
    action: "contact.note",
    resourceType: "contact",
    resourceId: contactId,
    after: { activityId: activity.id },
  });
  return activity;
}
