import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import type { InboxChannel } from "@prisma/client";

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
    where: { address: { equals: address.trim(), mode: "insensitive" }, channel },
    select: { organizationId: true },
  });
  return mailbox?.organizationId ?? null;
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

  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { slug: true },
  });

  try {
    return await db.inboxMailbox.create({
      data: { organizationId: ctx.orgId, channel, address: addressFor(org.slug, domain) },
    });
  } catch {
    // Rare race: another concurrent request just created it — read it back
    // rather than surfacing a spurious unique-constraint error.
    return db.inboxMailbox.findFirst({ where: { channel } });
  }
}
