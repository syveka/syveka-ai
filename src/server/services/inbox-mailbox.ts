import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { can } from "@/server/auth/permissions";
import { audit } from "./audit";
import type { InboxChannel } from "@/generated/prisma/client/client";

/**
 * Deterministic, collision-resistant local part derived from the org's slug.
 * Slugs are already unique per organization, so `{slug}@{domain}` is stable
 * and predictable — an operator can be told their address without a
 * separate provisioning step.
 */
function addressFor(slug: string, domain: string): string {
  return `${slug}@${domain}`.toLowerCase();
}

/**
 * Resolves the organization that owns a verified inbound recipient address.
 * This is the ONLY place an inbound webhook is allowed to learn which
 * organization a message belongs to — never trust an org id supplied
 * directly in the inbound payload. Pre-authentication by construction (a
 * webhook has no session), so it reads via `unscopedPrisma`, not `tenantDb`.
 */
export async function resolveOrgIdByMailboxAddress(
  address: string,
  channel: InboxChannel,
): Promise<string | null> {
  const mailbox = await unscopedPrisma.inboxMailbox.findFirst({
    // A soft-deleted org's mailbox stops accepting mail, as if unregistered.
    where: {
      address: { equals: address.trim(), mode: "insensitive" },
      channel,
      organization: { deletedAt: null },
    },
    select: { organizationId: true },
  });
  return mailbox?.organizationId ?? null;
}

/** Reads the org's mailbox for a channel without provisioning one. */
export async function getExistingMailbox(ctx: TenantContext, channel: InboxChannel = "EMAIL") {
  return tenantDb(ctx.orgId).inboxMailbox.findFirst({ where: { channel } });
}

/**
 * Lazily provisions (idempotent) and returns the org's mailbox address for a
 * channel. Called from an authenticated context (settings UI), so it's safe
 * to auto-create — an operator viewing their own settings implicitly wants
 * one to exist.
 */
export async function getOrCreateMailbox(ctx: TenantContext, channel: InboxChannel = "EMAIL") {
  const db = tenantDb(ctx.orgId);
  const existing = await db.inboxMailbox.findFirst({ where: { channel } });
  if (existing) return existing;

  const domain = process.env.INBOX_EMAIL_DOMAIN;
  if (!domain) return null;

  // `getTenantContext` already refuses soft-deleted orgs; re-checked here so
  // this write path can never provision an address for one regardless of
  // how it's called (a deleted org's address must stay unroutable).
  const org = await unscopedPrisma.organization.findFirst({
    where: { id: ctx.orgId, deletedAt: null },
    select: { slug: true },
  });
  if (!org) return null;

  let mailbox;
  try {
    mailbox = await db.inboxMailbox.create({
      data: { organizationId: ctx.orgId, channel, address: addressFor(org.slug, domain) },
    });
  } catch {
    // Rare race: another concurrent request just created it — read it back
    // rather than surfacing a spurious unique-constraint error.
    return db.inboxMailbox.findFirst({ where: { channel } });
  }
  await audit(ctx, {
    action: "inbox_mailbox.create",
    resourceType: "inbox_mailbox",
    resourceId: mailbox.id,
    after: { channel, address: mailbox.address },
  });
  return mailbox;
}

/**
 * The org mailbox as the current viewer may see it. Provisioning is org-level
 * channel configuration, so only roles with `org:update` (owner/admin) can
 * create it; everyone else only ever reads an already-provisioned address.
 */
export async function getMailboxForViewer(ctx: TenantContext, channel: InboxChannel = "EMAIL") {
  return can(ctx.role, "org:update")
    ? getOrCreateMailbox(ctx, channel)
    : getExistingMailbox(ctx, channel);
}
