import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Transaction-scoped Postgres advisory locks that serialize concurrent
 * check-then-write booking flows. Postgres's default READ COMMITTED isolation
 * lets two concurrent transactions each run a "is this slot free" SELECT
 * before either commits its INSERT - neither sees the other's uncommitted
 * write, so both pass the check. Taking one of these locks as the first
 * statement in the transaction, before the conflict check, forces a second
 * concurrent transaction to wait here until the first commits or rolls back,
 * so its own check correctly observes whatever the first just committed.
 *
 * Both use `pg_advisory_xact_lock` (not the session-scoped `pg_advisory_lock`),
 * so the lock is always auto-released at transaction end - no schema change,
 * no leak path.
 */

/**
 * Serializes bookings for one specific calendar owner within an organization.
 * Used by the guest-facing public booking flow (src/server/services/booking.ts),
 * where each booking type has one real owner and different owners' calendars
 * are independent, so unrelated owners must not block each other.
 */
export async function lockOwnerCalendar(
  tx: Prisma.TransactionClient,
  orgId: string,
  ownerId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${ownerId}))`;
}

/**
 * Serializes bookings against an organization's single shared calendar - no
 * owner scoping. Used by the AI `bookMeeting`/`getCalendarAvailability` tools
 * (src/server/ai/tools/index.ts), which intentionally treat "the company
 * calendar" as one bookable resource: their conflict checks are organization-
 * wide, not per-owner (CalendarEvent.ownerId is left null on AI-created
 * events), so the lock must match that scope to actually close the race.
 *
 * This intentionally does NOT serialize against lockOwnerCalendar (distinct
 * fixed second key, `0`, vs. a real owner's hashed id) - an AI-tool booking
 * and a concurrent guest-flow booking for the same underlying time slot use
 * different lock domains and are not currently reconciled. See
 * docs/DECISIONS.md for this known, deliberately deferred limitation.
 */
export async function lockOrgCalendar(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), 0)`;
}
