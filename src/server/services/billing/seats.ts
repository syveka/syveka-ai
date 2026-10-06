import "server-only";

import type { Prisma } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";

/**
 * Seats: memberships of a non-deleted organization. Membership rows are
 * removed (not flagged) when a member leaves, users have no soft delete, and
 * pending invitations aren't members, so counting membership rows is the
 * authoritative number.
 */

type SeatDb = Pick<Prisma.TransactionClient, "organizationMember">;

/** Members of a non-deleted organization. Scoped to `orgId`; a deleted organization has none. */
export async function countActiveSeats(
  orgId: string,
  db: SeatDb = unscopedPrisma,
): Promise<number> {
  return db.organizationMember.count({
    where: { organizationId: orgId, organization: { deletedAt: null } },
  });
}

/**
 * Serializes seat-count changes for one organization within a transaction.
 * Own key domain (`, 3`), distinct from the calendar locks (0, 1, 2 and the
 * per-owner pair), so it never waits on or blocks calendar or booking work.
 */
export async function lockOrgSeats(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), 3)`;
}
