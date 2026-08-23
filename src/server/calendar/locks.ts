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

/**
 * Serializes the Contact find-then-create critical section in
 * createPublicBooking() (src/server/services/booking.ts) for one
 * (organization, guest email) pair. Found necessary during PR #91 review:
 * lockOwnerCalendar()'s advisory lock is keyed on (orgId, ownerId), so two
 * concurrent bookings for *different* booking types (different owners)
 * within the same org - a real scenario, e.g. two services booked at once
 * by the same brand-new customer - are never serialized against each
 * other, and a bare find-then-create can commit two Contact rows for the
 * same new email. Reproduced with a deterministic real-Postgres test before
 * this fix, confirmed closed after it.
 *
 * A single combined hashtext() over "orgId:email" (not two separate
 * hashtext() calls) with a fixed second key (`1`) keeps this lock domain
 * fully distinct from lockOwnerCalendar's (hashtext(orgId), hashtext(ownerId))
 * and lockOrgCalendar's (hashtext(orgId), 0) - a same-org booking and a
 * same-org contact-email claim can never accidentally collide on the same
 * two-key advisory lock.
 */
export async function lockContactEmail(
  tx: Prisma.TransactionClient,
  orgId: string,
  email: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId} || ':' || ${email}), 1)`;
}

/**
 * Serializes AI-default BookingType claims within one organization
 * (src/server/services/booking.ts's saveBookingType, whenever a caller sets
 * isAiBookingDefault=true). Distinct fixed second key (`2`) from
 * lockOrgCalendar's (`0`) and lockContactEmail's (`1`) - deliberately its
 * own lock domain, never intended to interact with booking-slot scheduling.
 *
 * A plain transaction around "update the claimed row, then clear other
 * defaults" is NOT sufficient on its own: two concurrent transactions each
 * claiming a DIFFERENT BookingType as the default touch different rows, so
 * neither's row-level lock serializes against the other under READ
 * COMMITTED - each can commit its own "true" write before the other's
 * "clear other defaults" cleanup runs, and depending on interleaving this
 * can leave the org with zero true rows (both cleanups fire after seeing
 * the other's committed true value) rather than exactly one. Taking this
 * lock as the transaction's first statement forces the second concurrent
 * claim to fully wait for the first's claim-and-cleanup to commit before
 * it even starts, closing that race. See docs/DECISIONS.md.
 */
export async function lockAiDefaultBookingType(
  tx: Prisma.TransactionClient,
  orgId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${orgId}), 2)`;
}
