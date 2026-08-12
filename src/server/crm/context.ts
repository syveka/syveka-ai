import "server-only";

import { tenantDb } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";

export type CrmContactContext = {
  firstName: string;
  lastName: string | null;
  email: string | null;
  title: string | null;
  status: string;
  companyName: string | null;
};

export type CrmDealContext = {
  title: string;
  stageName: string;
  valueCents: number;
  currency: string;
  expectedCloseAt: Date | null;
};

const CONTACT_SELECT = {
  firstName: true,
  lastName: true,
  email: true,
  title: true,
  status: true,
  company: { select: { name: true } },
} as const;

const DEAL_SELECT = {
  title: true,
  valueCents: true,
  currency: true,
  expectedCloseAt: true,
  stage: { select: { name: true } },
} as const;

/**
 * The single tenant-scoped read for "who is this customer" context, shared
 * between the booking assistant and Inbox AI drafts — this is what keeps a
 * VIP contact or an in-progress deal visible to every AI surface that
 * responds to a customer, instead of each one deciding independently
 * whether to bother looking it up.
 */
export async function getCrmContactContext(
  ctx: TenantContext,
  contactId: string,
): Promise<CrmContactContext | null> {
  const contact = await tenantDb(ctx.orgId).contact.findFirst({
    where: { id: contactId, deletedAt: null },
    select: CONTACT_SELECT,
  });
  if (!contact) return null;
  return {
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    title: contact.title,
    status: contact.status,
    companyName: contact.company?.name ?? null,
  };
}

export async function getCrmDealContext(
  ctx: TenantContext,
  dealId: string,
): Promise<CrmDealContext | null> {
  const deal = await tenantDb(ctx.orgId).deal.findFirst({
    where: { id: dealId, deletedAt: null },
    select: DEAL_SELECT,
  });
  if (!deal) return null;
  return {
    title: deal.title,
    stageName: deal.stage.name,
    valueCents: deal.valueCents,
    currency: deal.currency,
    expectedCloseAt: deal.expectedCloseAt,
  };
}

/**
 * For a contact without a specific deal already in hand (e.g. Inbox, which
 * only knows the thread's linked contact) — the contact's most recently
 * updated still-open deal, if any. `closedAt: null` excludes won/lost deals
 * so a stale, already-decided deal never gets surfaced as if it were live.
 */
export async function findActiveDealForContact(
  ctx: TenantContext,
  contactId: string,
): Promise<CrmDealContext | null> {
  const deal = await tenantDb(ctx.orgId).deal.findFirst({
    where: { contactId, deletedAt: null, closedAt: null },
    orderBy: { updatedAt: "desc" },
    select: DEAL_SELECT,
  });
  if (!deal) return null;
  return {
    title: deal.title,
    stageName: deal.stage.name,
    valueCents: deal.valueCents,
    currency: deal.currency,
    expectedCloseAt: deal.expectedCloseAt,
  };
}

export function formatCrmContactLine(contact: CrmContactContext): string {
  const namePart = `${contact.firstName} ${contact.lastName ?? ""}`.trim();
  const titlePart = contact.title ? `, ${contact.title}` : "";
  const companyPart = contact.companyName ? `, ${contact.companyName}` : "";
  return `Contact: ${namePart} (${contact.email ?? "no email"})${titlePart}${companyPart} — status ${contact.status}`;
}

export function formatCrmDealLine(deal: CrmDealContext): string {
  const closePart = deal.expectedCloseAt
    ? `, expected close ${deal.expectedCloseAt.toISOString().slice(0, 10)}`
    : "";
  return `Deal: "${deal.title}" — stage ${deal.stageName}, value ${(deal.valueCents / 100).toFixed(0)} ${deal.currency}${closePart}`;
}
