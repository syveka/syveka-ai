import "server-only";

import { createHash } from "node:crypto";
import type { Plan, Prisma } from "@/generated/prisma/client/client";
import { unscopedPrisma } from "@/server/db/tenant";
import { audit } from "@/server/services/audit";
import { SEAT_BILLING_POLICY, type ExtraSeatPolicy } from "@/lib/billing/plan-catalog";

/**
 * Seat billing: included seats + paid extra seats.
 *
 * A billable seat is a membership of a non-deleted organization. Membership
 * rows are removed (not flagged) when a member leaves, users have no soft
 * delete, and pending invitations aren't members, so counting membership
 * rows is the authoritative number.
 *
 * Nothing here charges a customer yet: reconcileSeatBilling() writes through
 * a SeatBillingGateway, and no Stripe implementation exists until extra-seat
 * prices and a proration policy are approved (docs/billing/seat-billing.md).
 */

export type SeatBilling = {
  plan: Plan;
  activeSeats: number;
  includedSeats: number;
  extraSeatPolicy: ExtraSeatPolicy;
  /** max(activeSeats - includedSeats, 0), and 0 unless extra seats are paid. */
  billableExtraSeats: number;
};

export function computeSeatBilling(plan: Plan, activeSeats: number): SeatBilling {
  if (!Number.isInteger(activeSeats) || activeSeats < 0) {
    throw new RangeError("activeSeats must be a non-negative integer");
  }
  const { includedSeats, extraSeats } = SEAT_BILLING_POLICY[plan];
  return {
    plan,
    activeSeats,
    includedSeats,
    extraSeatPolicy: extraSeats,
    billableExtraSeats: extraSeats === "paid" ? Math.max(activeSeats - includedSeats, 0) : 0,
  };
}

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

/**
 * Where a provider stores the extra-seat quantity. A Stripe implementation
 * needs the approved extra-seat price (a subscription item of its own).
 */
export interface SeatBillingGateway {
  getExtraSeatQuantity(subscriptionId: string): Promise<number>;
  setExtraSeatQuantity(
    subscriptionId: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<void>;
}

export type SeatSyncResult =
  | { status: "in_sync"; billableExtraSeats: number }
  | { status: "updated"; from: number; to: number }
  | {
      status: "not_billable";
      reason:
        | "organization_deleted"
        | "no_paid_subscription"
        | "plan_without_paid_seats"
        | "custom_contract";
    }
  | {
      status: "failed";
      retryable: true;
      reason: "billing_provider_unavailable" | "membership_changing";
    };

const PAID_STATUSES: ReadonlySet<string> = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

/**
 * Same membership set and target → same key, so a repeated event can't
 * double-apply; a changed set gets a new key even for an equal quantity
 * (3 → 4 → 3 must write again).
 */
export function seatSyncIdempotencyKey(
  orgId: string,
  subscriptionId: string,
  membershipIds: readonly string[],
  quantity: number,
): string {
  const digest = createHash("sha256")
    .update(
      [orgId, subscriptionId, [...membershipIds].sort().join(","), String(quantity)].join("|"),
    )
    .digest("hex");
  return `seat-sync:${digest}`;
}

type ReconcileDeps = {
  db?: Pick<typeof unscopedPrisma, "organization" | "subscription" | "organizationMember">;
  auditFn?: typeof audit;
  maxRounds?: number;
};

/**
 * Converges the provider's extra-seat quantity to the current membership.
 * Each round reads the membership, compares with the provider and writes
 * only on a difference; after a write it reads again. So of two concurrent
 * runs, the one that writes last also verifies last: a stale write is
 * corrected by its own next round. Every membership change must trigger a
 * run after its transaction commits.
 *
 * Failures never grant anything: the result is "failed" (retryable) and the
 * caller retries; seat enforcement must not assume the write happened.
 */
export async function reconcileSeatBilling(
  orgId: string,
  gateway: SeatBillingGateway,
  deps: ReconcileDeps = {},
): Promise<SeatSyncResult> {
  const db = deps.db ?? unscopedPrisma;
  const auditFn = deps.auditFn ?? audit;
  const maxRounds = deps.maxRounds ?? 3;
  // Quantity before this run's first write; null until it writes.
  let firstFrom: number | null = null;

  for (let round = 0; round < maxRounds; round++) {
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { deletedAt: true },
    });
    if (!org || org.deletedAt) return { status: "not_billable", reason: "organization_deleted" };

    const sub = await db.subscription.findUnique({
      where: { organizationId: orgId },
      select: { plan: true, status: true, stripeSubscriptionId: true },
    });
    if (!sub?.stripeSubscriptionId || !PAID_STATUSES.has(sub.status)) {
      return { status: "not_billable", reason: "no_paid_subscription" };
    }
    const policy = SEAT_BILLING_POLICY[sub.plan].extraSeats;
    if (policy === "none") return { status: "not_billable", reason: "plan_without_paid_seats" };
    if (policy === "custom") return { status: "not_billable", reason: "custom_contract" };

    const members = await db.organizationMember.findMany({
      where: { organizationId: orgId, organization: { deletedAt: null } },
      select: { id: true },
    });
    const target = computeSeatBilling(sub.plan, members.length).billableExtraSeats;

    let current: number;
    try {
      current = await gateway.getExtraSeatQuantity(sub.stripeSubscriptionId);
    } catch {
      return {
        status: "failed",
        retryable: true,
        reason: "billing_provider_unavailable",
      };
    }
    if (current === target) {
      return firstFrom !== null
        ? { status: "updated", from: firstFrom, to: target }
        : { status: "in_sync", billableExtraSeats: target };
    }

    const key = seatSyncIdempotencyKey(
      orgId,
      sub.stripeSubscriptionId,
      members.map((m) => m.id),
      target,
    );
    try {
      await gateway.setExtraSeatQuantity(sub.stripeSubscriptionId, target, key);
    } catch {
      return {
        status: "failed",
        retryable: true,
        reason: "billing_provider_unavailable",
      };
    }
    firstFrom ??= current;

    await auditFn(
      { orgId, userId: "" },
      {
        action: "billing.extra_seats_synced",
        resourceType: "subscription",
        actorType: "system",
        before: { extraSeats: current },
        after: { extraSeats: target, activeSeats: members.length },
      },
    ).catch((e: unknown) => {
      // The quantity is already correct at the provider; only the record is missing.
      console.error(
        JSON.stringify({
          event: "billing_seat_sync_audit_failed",
          name: e instanceof Error ? e.name : "unknown",
        }),
      );
    });
  }
  return { status: "failed", retryable: true, reason: "membership_changing" };
}
