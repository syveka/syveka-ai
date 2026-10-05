import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Seat billing infrastructure: included seats + paid extra seats. Pure
 * computation, the authoritative seat count, and reconciliation against a
 * fake billing gateway (no Stripe implementation exists yet).
 */

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: {} }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));

import {
  computeSeatBilling,
  countActiveSeats,
  reconcileSeatBilling,
  seatSyncIdempotencyKey,
  type SeatBillingGateway,
} from "@/server/services/billing/seats";
import { SEAT_BILLING_POLICY } from "@/lib/billing/plan-catalog";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUB_A = "sub_synthetic_a";

type Row = Record<string, unknown>;

/** In-memory organizations, subscriptions and memberships for two tenants. */
function makeStore() {
  const state = {
    orgs: new Map<string, { deletedAt: Date | null }>([
      [ORG_A, { deletedAt: null }],
      [ORG_B, { deletedAt: null }],
    ]),
    subs: new Map<string, { plan: string; status: string; stripeSubscriptionId: string | null }>(),
    members: [] as Array<{ id: string; organizationId: string }>,
    seq: 0,
  };
  const live = (orgId: string) => state.orgs.get(orgId)?.deletedAt === null;
  const scoped = (where: Row) => {
    expect(where.organizationId).toBeTypeOf("string"); // every query is tenant-scoped
    const orgId = where.organizationId as string;
    const requiresLiveOrg =
      (where.organization as { deletedAt?: null } | undefined)?.deletedAt === null;
    if (requiresLiveOrg && !live(orgId)) return [];
    return state.members.filter((m) => m.organizationId === orgId);
  };
  const db = {
    organization: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => state.orgs.get(where.id) ?? null,
      ),
    },
    subscription: {
      findUnique: vi.fn(
        async ({ where }: { where: { organizationId: string } }) =>
          state.subs.get(where.organizationId) ?? null,
      ),
    },
    organizationMember: {
      count: vi.fn(async ({ where }: { where: Row }) => scoped(where).length),
      findMany: vi.fn(async ({ where }: { where: Row }) =>
        scoped(where).map((m) => ({ id: m.id })),
      ),
    },
  };
  const addMembers = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++)
      state.members.push({ id: `m-${++state.seq}`, organizationId: orgId });
  };
  const removeMember = (orgId: string) => {
    const i = state.members.findIndex((m) => m.organizationId === orgId);
    state.members.splice(i, 1);
  };
  return { state, db, addMembers, removeMember };
}

function makeGateway(initial = 0) {
  let quantity = initial;
  const gateway = {
    getExtraSeatQuantity: vi.fn(async () => quantity),
    setExtraSeatQuantity: vi.fn(async (_sub: string, q: number) => {
      quantity = q;
    }),
  };
  return { gateway: gateway as SeatBillingGateway & typeof gateway, quantity: () => quantity };
}

describe("computeSeatBilling (included seats + paid extra seats)", () => {
  it("uses the target included seats: FREE 1, STARTER 2, PRO 5, ENTERPRISE custom", () => {
    expect(SEAT_BILLING_POLICY).toEqual({
      FREE: { includedSeats: 1, extraSeats: "none" },
      STARTER: { includedSeats: 2, extraSeats: "paid" },
      PRO: { includedSeats: 5, extraSeats: "paid" },
      ENTERPRISE: { includedSeats: 0, extraSeats: "custom" },
    });
  });

  it("FREE never bills extra seats", () => {
    expect(computeSeatBilling("FREE", 1).billableExtraSeats).toBe(0);
    expect(computeSeatBilling("FREE", 2).billableExtraSeats).toBe(0);
  });

  it.each([
    ["STARTER", 1, 0, "first included member"],
    ["STARTER", 2, 0, "last included member"],
    ["STARTER", 3, 1, "first paid extra seat"],
    ["STARTER", 7, 5, "multiple extra seats"],
    ["PRO", 5, 0, "last included member"],
    ["PRO", 6, 1, "first paid extra seat"],
    ["PRO", 12, 7, "multiple extra seats"],
  ] as const)("%s with %i members bills %i extra seats (%s)", (plan, active, extra, _case) => {
    const result = computeSeatBilling(plan, active);
    expect(result.billableExtraSeats).toBe(extra);
    expect(result.extraSeatPolicy).toBe("paid");
  });

  it("ENTERPRISE is billed by contract, never by this formula", () => {
    const result = computeSeatBilling("ENTERPRISE", 80);
    expect(result.extraSeatPolicy).toBe("custom");
    expect(result.billableExtraSeats).toBe(0);
  });

  it("rejects an impossible seat count", () => {
    expect(() => computeSeatBilling("STARTER", -1)).toThrow(RangeError);
    expect(() => computeSeatBilling("STARTER", 1.5)).toThrow(RangeError);
  });
});

describe("countActiveSeats", () => {
  it("counts only this organization's members (cross-tenant)", async () => {
    const { db, addMembers } = makeStore();
    addMembers(ORG_A, 3);
    addMembers(ORG_B, 9);
    await expect(countActiveSeats(ORG_A, db as never)).resolves.toBe(3);
    await expect(countActiveSeats(ORG_B, db as never)).resolves.toBe(9);
  });

  it("is zero for a deleted organization", async () => {
    const { state, db, addMembers } = makeStore();
    addMembers(ORG_A, 4);
    state.orgs.set(ORG_A, { deletedAt: new Date() });
    await expect(countActiveSeats(ORG_A, db as never)).resolves.toBe(0);
  });
});

describe("reconcileSeatBilling", () => {
  let store: ReturnType<typeof makeStore>;
  let auditFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = makeStore();
    auditFn = vi.fn(async () => undefined);
    store.state.subs.set(ORG_A, { plan: "STARTER", status: "ACTIVE", stripeSubscriptionId: SUB_A });
  });

  const run = (gateway: SeatBillingGateway) =>
    reconcileSeatBilling(ORG_A, gateway, { db: store.db as never, auditFn: auditFn as never });

  it("does nothing while members fit in the included seats", async () => {
    store.addMembers(ORG_A, 2);
    const { gateway } = makeGateway(0);
    await expect(run(gateway)).resolves.toEqual({ status: "in_sync", billableExtraSeats: 0 });
    expect(gateway.setExtraSeatQuantity).not.toHaveBeenCalled();
    expect(auditFn).not.toHaveBeenCalled();
  });

  it("bills the first paid extra seat, with an audit record", async () => {
    store.addMembers(ORG_A, 3);
    const { gateway, quantity } = makeGateway(0);
    await expect(run(gateway)).resolves.toEqual({ status: "updated", from: 0, to: 1 });
    expect(quantity()).toBe(1);
    expect(auditFn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_A }),
      expect.objectContaining({
        action: "billing.extra_seats_synced",
        actorType: "system",
        before: { extraSeats: 0 },
        after: { extraSeats: 1, activeSeats: 3 },
      }),
    );
  });

  it("bills multiple extra seats and lowers them when a member is removed", async () => {
    store.addMembers(ORG_A, 6);
    const { gateway, quantity } = makeGateway(0);
    await run(gateway);
    expect(quantity()).toBe(4);

    store.removeMember(ORG_A);
    await expect(run(gateway)).resolves.toEqual({ status: "updated", from: 4, to: 3 });
    expect(quantity()).toBe(3);
  });

  it("is idempotent: a repeated event writes nothing", async () => {
    store.addMembers(ORG_A, 4);
    const { gateway } = makeGateway(0);
    await run(gateway);
    await expect(run(gateway)).resolves.toEqual({ status: "in_sync", billableExtraSeats: 2 });
    await run(gateway);
    expect(gateway.setExtraSeatQuantity).toHaveBeenCalledTimes(1);
  });

  it("uses one idempotency key per membership set and target", () => {
    const a = seatSyncIdempotencyKey(ORG_A, SUB_A, ["m-2", "m-1"], 3);
    expect(seatSyncIdempotencyKey(ORG_A, SUB_A, ["m-1", "m-2"], 3)).toBe(a); // order-independent
    // A different set with the same quantity (3 -> 4 -> 3) must write again.
    expect(seatSyncIdempotencyKey(ORG_A, SUB_A, ["m-1", "m-9"], 3)).not.toBe(a);
    expect(seatSyncIdempotencyKey(ORG_B, SUB_A, ["m-2", "m-1"], 3)).not.toBe(a);
    expect(a).toMatch(/^seat-sync:[0-9a-f]{64}$/);
  });

  it("converges when membership changes while a write is in flight", async () => {
    store.addMembers(ORG_A, 3); // 1 extra
    let quantity = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteHeld = new Promise<void>((r) => (releaseFirstWrite = r));
    let writes = 0;
    const gateway: SeatBillingGateway = {
      getExtraSeatQuantity: vi.fn(async () => quantity),
      setExtraSeatQuantity: vi.fn(async (_sub: string, q: number) => {
        writes += 1;
        if (writes === 1) await firstWriteHeld; // run A's stale write lands last
        quantity = q;
      }),
    };

    const runA = run(gateway);
    await vi.waitFor(() => expect(writes).toBe(1));
    store.addMembers(ORG_A, 2); // now 5 members -> 3 extra
    const runB = run(gateway);
    await expect(runB).resolves.toEqual({ status: "updated", from: 0, to: 3 });
    releaseFirstWrite(); // A writes its stale 1, then re-reads and corrects
    await runA;

    expect(quantity).toBe(3);
  });

  it("reports a retryable failure and grants nothing when the provider is down", async () => {
    store.addMembers(ORG_A, 5);
    const read = {
      getExtraSeatQuantity: vi.fn(async () => {
        throw new Error("stripe down");
      }),
      setExtraSeatQuantity: vi.fn(),
    };
    await expect(run(read)).resolves.toEqual({
      status: "failed",
      retryable: true,
      reason: "billing_provider_unavailable",
    });
    expect(read.setExtraSeatQuantity).not.toHaveBeenCalled();

    const write = {
      getExtraSeatQuantity: vi.fn(async () => 0),
      setExtraSeatQuantity: vi.fn(async () => {
        throw new Error("stripe down");
      }),
    };
    await expect(run(write)).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(auditFn).not.toHaveBeenCalled();
  });

  it.each([
    ["FREE", "ACTIVE", SUB_A, "plan_without_paid_seats"],
    ["ENTERPRISE", "ACTIVE", SUB_A, "custom_contract"],
    ["STARTER", "CANCELED", SUB_A, "no_paid_subscription"],
    ["STARTER", "ACTIVE", null, "no_paid_subscription"],
  ] as const)(
    "%s / %s / subscription %s is not billable here (%s)",
    async (plan, status, sub, reason) => {
      store.state.subs.set(ORG_A, { plan, status, stripeSubscriptionId: sub });
      store.addMembers(ORG_A, 9);
      const { gateway } = makeGateway(0);
      await expect(run(gateway)).resolves.toEqual({ status: "not_billable", reason });
      expect(gateway.getExtraSeatQuantity).not.toHaveBeenCalled();
      expect(gateway.setExtraSeatQuantity).not.toHaveBeenCalled();
    },
  );

  it("never bills a deleted organization", async () => {
    store.addMembers(ORG_A, 9);
    store.state.orgs.set(ORG_A, { deletedAt: new Date() });
    const { gateway } = makeGateway(0);
    await expect(run(gateway)).resolves.toEqual({
      status: "not_billable",
      reason: "organization_deleted",
    });
    expect(gateway.setExtraSeatQuantity).not.toHaveBeenCalled();
  });

  it("counts only its own organization's members (cross-tenant)", async () => {
    store.addMembers(ORG_A, 2);
    store.addMembers(ORG_B, 40);
    const { gateway } = makeGateway(0);
    await expect(run(gateway)).resolves.toEqual({ status: "in_sync", billableExtraSeats: 0 });
    for (const [args] of store.db.organizationMember.findMany.mock.calls) {
      expect((args as { where: Row }).where.organizationId).toBe(ORG_A);
    }
  });
});
