import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Starting or changing a paid plan (startPlanChange) with the real Stripe
 * integration helpers over a stateful fake Stripe API (customers,
 * subscriptions, Checkout and Billing Portal sessions, idempotency keys), a
 * fake organization/subscription table and a fake Redis. No live Stripe call.
 *
 * Checks that an organization with any existing subscription is sent to the
 * Billing Portal instead of a second Checkout, that two tabs or a double
 * click can't both open Checkouts, that the Stripe customer is created once
 * per organization, and that nothing touches another organization.
 */

type Org = {
  name: string;
  stripeCustomerId: string | null;
  subscription: { stripeSubscriptionId: string | null; status: string } | null;
  members: number;
};

const s = vi.hoisted(() => ({
  orgs: new Map<string, Org>(),
  customers: [] as Array<{ id: string; orgId: string }>,
  idempotency: new Map<string, unknown>(),
  stripeSubs: new Map<string, Array<{ status: string }>>(),
  sessions: [] as Array<{
    id: string;
    customer: string;
    status: string;
    url: string;
    metadata: Record<string, string>;
  }>,
  locks: new Map<string, string>(),
  redisDown: false,
  lockAlwaysFree: false,
  limited: null as null | "rate_limited" | "service_unavailable",
  calls: { customersCreate: 0, sessionsCreate: 0, portal: 0 },
}));

function idempotent<T>(key: string | undefined, make: () => T): T {
  if (key && s.idempotency.has(key)) return s.idempotency.get(key) as T;
  const value = make();
  if (key) s.idempotency.set(key, value);
  return value;
}

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = {
      create: async (params: { metadata: { orgId: string } }, opts?: { idempotencyKey?: string }) =>
        idempotent(opts?.idempotencyKey, () => {
          s.calls.customersCreate++;
          const customer = { id: `cus_${s.customers.length + 1}`, orgId: params.metadata.orgId };
          s.customers.push(customer);
          return { id: customer.id };
        }),
    };
    subscriptions = {
      list: async ({ customer }: { customer: string }) => ({
        data: s.stripeSubs.get(customer) ?? [],
      }),
    };
    checkout = {
      sessions: {
        list: async ({ customer, status }: { customer: string; status: string }) => ({
          data: s.sessions.filter((x) => x.customer === customer && x.status === status),
        }),
        expire: async (id: string) => {
          const session = s.sessions.find((x) => x.id === id)!;
          session.status = "expired";
          return session;
        },
        create: async (
          params: { customer: string; metadata: Record<string, string> },
          opts?: { idempotencyKey?: string },
        ) =>
          idempotent(opts?.idempotencyKey, () => {
            s.calls.sessionsCreate++;
            const id = `cs_${s.sessions.length + 1}`;
            const session = {
              id,
              customer: params.customer,
              status: "open",
              url: `https://checkout.test/${id}`,
              metadata: params.metadata,
            };
            s.sessions.push(session);
            return session;
          }),
      },
    };
    billingPortal = {
      sessions: {
        create: async ({ customer }: { customer: string }) => {
          s.calls.portal++;
          return { url: `https://portal.test/${customer}` };
        },
      },
    };
  },
}));
vi.mock("@/env", () => ({
  getStripeEnv: () => ({
    STRIPE_SECRET_KEY: "sk_test_fake",
    NEXT_PUBLIC_APP_URL: "https://app.test",
    STRIPE_PRICE_STARTER_MONTHLY: "price_starter_m",
    STRIPE_PRICE_STARTER_ANNUAL: "price_starter_a",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_m",
    STRIPE_PRICE_PRO_ANNUAL: "price_pro_a",
  }),
}));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    set: async (key: string, value: string, opts: { nx: boolean }) => {
      if (s.redisDown) throw new Error("redis timeout");
      if (s.lockAlwaysFree) return "OK";
      if (opts.nx && s.locks.has(key)) return null;
      s.locks.set(key, value);
      return "OK";
    },
    eval: async (_script: string, keys: string[], args: string[]) => {
      if (s.locks.get(keys[0]!) === args[0]) s.locks.delete(keys[0]!);
      return 1;
    },
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  actionRateLimitError: vi.fn(async () => s.limited),
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const org = s.orgs.get(where.id);
        if (!org) throw new Error("not found");
        // Yield, like a real read, so concurrent calls interleave.
        await new Promise((r) => setTimeout(r, 0));
        return {
          name: org.name,
          stripeCustomerId: org.stripeCustomerId,
          subscription: org.subscription,
          _count: { members: org.members },
        };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; stripeCustomerId: null };
        data: { stripeCustomerId: string };
      }) => {
        const org = s.orgs.get(where.id);
        if (!org || org.stripeCustomerId !== null) return { count: 0 };
        org.stripeCustomerId = data.stripeCustomerId;
        return { count: 1 };
      },
    },
  },
}));

import { startPlanChange } from "@/server/services/billing/plan-change";

const ctxA = { orgId: "org-a", userId: "user-a", email: "owner@a.test", locale: "en" };
const ctxB = { orgId: "org-b", userId: "user-b", email: "owner@b.test", locale: "fi" };

function openSessions(customer?: string) {
  return s.sessions.filter((x) => x.status === "open" && (!customer || x.customer === customer));
}

beforeEach(() => {
  s.orgs = new Map([
    ["org-a", { name: "A", stripeCustomerId: null, subscription: null, members: 2 }],
    ["org-b", { name: "B", stripeCustomerId: "cus_b", subscription: null, members: 1 }],
  ]);
  s.customers = [];
  s.idempotency = new Map();
  s.stripeSubs = new Map();
  s.sessions = [];
  s.locks = new Map();
  s.redisDown = false;
  s.lockAlwaysFree = false;
  s.limited = null;
  s.calls = { customersCreate: 0, sessionsCreate: 0, portal: 0 };
});

describe("an organization without a subscription", () => {
  it("gets one Checkout, after one Stripe customer is created and stored", async () => {
    const result = await startPlanChange(ctxA, "PRO", "monthly");
    expect(result).toEqual({ kind: "checkout", url: "https://checkout.test/cs_1" });
    expect(s.calls.customersCreate).toBe(1);
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_1");
    expect(openSessions()).toHaveLength(1);
    expect(openSessions()[0]!.metadata).toEqual({
      orgId: "org-a",
      plan: "PRO",
      interval: "monthly",
    });
  });

  it("the same plan chosen again reuses the open Checkout instead of creating another", async () => {
    await startPlanChange(ctxA, "PRO", "monthly");
    const again = await startPlanChange(ctxA, "PRO", "monthly");
    expect(again).toEqual({ kind: "checkout", url: "https://checkout.test/cs_1" });
    expect(s.calls.sessionsCreate).toBe(1);
  });

  it("a different plan expires the earlier open Checkout, so only one can complete", async () => {
    await startPlanChange(ctxA, "STARTER", "monthly");
    await startPlanChange(ctxA, "PRO", "annual");
    expect(openSessions()).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ plan: "PRO" }) }),
    ]);
    expect(s.sessions.find((x) => x.id === "cs_1")!.status).toBe("expired");
  });

  it("a Stripe subscription that has fully ended doesn't block a new Checkout", async () => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    s.stripeSubs.set("cus_a", [{ status: "canceled" }, { status: "incomplete_expired" }]);
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });
});

describe("an organization with a subscription goes to the Billing Portal", () => {
  it.each(["ACTIVE", "TRIALING", "PAST_DUE", "INCOMPLETE", "PAUSED"])(
    "our stored status %s → portal, no Checkout",
    async (status) => {
      Object.assign(s.orgs.get("org-a")!, {
        stripeCustomerId: "cus_a",
        subscription: { stripeSubscriptionId: "sub_1", status },
      });
      const result = await startPlanChange(ctxA, "STARTER", "annual");
      expect(result).toEqual({ kind: "portal", url: "https://portal.test/cus_a" });
      expect(s.calls.sessionsCreate).toBe(0);
    },
  );

  it.each(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"])(
    "Stripe reports %s before our webhook has stored it → portal, no Checkout",
    async (status) => {
      s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
      s.stripeSubs.set("cus_a", [{ status }]);
      expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
        kind: "portal",
        url: "https://portal.test/cus_a",
      });
      expect(s.calls.sessionsCreate).toBe(0);
    },
  );

  it("a CANCELED stored subscription is not a reason for the portal", async () => {
    Object.assign(s.orgs.get("org-a")!, {
      stripeCustomerId: "cus_a",
      subscription: { stripeSubscriptionId: null, status: "CANCELED" },
    });
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });
});

describe("races", () => {
  it("two concurrent attempts (two tabs, double click): one proceeds, the other is told it's busy", async () => {
    const [first, second] = await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "STARTER", "monthly"),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["checkout", "refused"]);
    expect([first, second]).toContainEqual({ kind: "refused", reason: "busy" });
    expect(s.calls.customersCreate).toBe(1);
    expect(openSessions()).toHaveLength(1);
  });

  it("the claim is released afterwards, so the next attempt isn't refused", async () => {
    await startPlanChange(ctxA, "PRO", "monthly");
    expect(s.locks.size).toBe(0);
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });

  it("even if two attempts overlap anyway, exactly one Stripe customer results", async () => {
    // e.g. the first claim expired while its request was still running. The
    // claim is what prevents two Checkouts; without it, the customer's
    // idempotency key and the conditional store still keep it to one.
    s.lockAlwaysFree = true;
    await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "PRO", "monthly"),
    ]);
    expect(s.customers).toHaveLength(1);
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_1");
  });

  it("a customer stored by a concurrent request wins; the stored id is never overwritten", async () => {
    s.lockAlwaysFree = true;
    const results = await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "PRO", "monthly"),
    ]);
    expect(results.every((r) => r.kind === "checkout")).toBe(true);
    expect(new Set(s.sessions.map((x) => x.customer))).toEqual(new Set(["cus_1"]));
  });
});

describe("idempotent retries", () => {
  it("customer creation uses one key per organization; Checkout creation one key per attempt", async () => {
    await startPlanChange(ctxA, "PRO", "monthly");
    const keys = [...s.idempotency.keys()];
    expect(keys).toContain("org-customer:org-a");
    expect(keys.filter((k) => /^checkout:org-a:[0-9a-f-]{36}$/.test(k))).toHaveLength(1);
  });

  it("a replayed customer creation (same key) returns the same customer", async () => {
    s.idempotency.set("org-customer:org-a", { id: "cus_earlier" });
    await startPlanChange(ctxA, "PRO", "monthly");
    expect(s.calls.customersCreate).toBe(0);
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_earlier");
  });
});

describe("fails closed", () => {
  it.each([
    ["rate_limited", "busy"],
    ["service_unavailable", "unavailable"],
  ] as const)("rate limit %s → refused %s, before any Stripe call", async (limited, reason) => {
    s.limited = limited;
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({ kind: "refused", reason });
    expect(s.calls).toEqual({ customersCreate: 0, sessionsCreate: 0, portal: 0 });
  });

  it("Redis can't take the claim → unavailable, never an unguarded Checkout", async () => {
    s.redisDown = true;
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "refused",
      reason: "unavailable",
    });
    expect(s.calls).toEqual({ customersCreate: 0, sessionsCreate: 0, portal: 0 });
  });
});

describe("no cross-organization effect", () => {
  it("org A's checkout never expires, reuses or creates anything for org B", async () => {
    await startPlanChange(ctxB, "STARTER", "monthly");
    const bSession = openSessions("cus_b")[0]!;
    await startPlanChange(ctxA, "PRO", "monthly");
    expect(bSession.status).toBe("open");
    expect(s.orgs.get("org-b")!.stripeCustomerId).toBe("cus_b");
    expect(openSessions("cus_1")).toHaveLength(1);
  });

  it("a paying org B doesn't send org A to the portal", async () => {
    s.stripeSubs.set("cus_b", [{ status: "active" }]);
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });
});
