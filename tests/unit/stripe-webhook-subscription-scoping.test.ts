import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An organization has one subscription row, but a Stripe customer can have
 * more than one subscription over time (an older one being retired, a second
 * checkout, a stale retry). These scenarios run the real webhook route over a
 * small stateful fake of the organization, subscription and ledger tables
 * and of Stripe's current subscription state, and check the row each time:
 * only the subscription an event is about can change it, and only one that
 * may be current can become current.
 */

type SubRow = { stripeSubscriptionId: string | null; plan: string; status: string; seats: number };
type StripeSub = {
  id: string;
  customer: string;
  status: string;
  metadata: { orgId?: string };
  items: { data: Array<{ price: { id: string }; quantity: number }> };
  current_period_end: number;
  cancel_at_period_end: boolean;
  trial_end: number | null;
};

const state = vi.hoisted(() => ({
  orgs: new Map<string, { stripeCustomerId: string | null }>(),
  subs: new Map<string, SubRow>(),
  ledger: new Map<string, { status: string }>(),
  stripeSubs: new Map<string, StripeSub>(),
  event: null as unknown,
}));

function where<T>(rows: Map<string, T>, orgId: string): T | undefined {
  return rows.get(orgId);
}

const db = vi.hoisted(() => {
  const subscription = {
    findUnique: async ({ where: w }: { where: { organizationId: string } }) =>
      state.subs.get(w.organizationId) ?? null,
    upsert: async ({
      where: w,
      create,
      update,
    }: {
      where: { organizationId: string };
      create: SubRow;
      update: Partial<SubRow>;
    }) => {
      const row = state.subs.get(w.organizationId);
      if (row) Object.assign(row, update);
      else state.subs.set(w.organizationId, { ...create });
      return state.subs.get(w.organizationId);
    },
    updateMany: async ({
      where: w,
      data,
    }: {
      where: { organizationId: string; stripeSubscriptionId?: string };
      data: Partial<SubRow>;
    }) => {
      const row = state.subs.get(w.organizationId);
      if (
        !row ||
        (w.stripeSubscriptionId !== undefined &&
          row.stripeSubscriptionId !== w.stripeSubscriptionId)
      ) {
        return { count: 0 };
      }
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const organization = {
    findUnique: async ({ where: w }: { where: { id?: string; stripeCustomerId?: string } }) => {
      if (w.id) {
        const org = state.orgs.get(w.id);
        return org ? { id: w.id, ...org } : null;
      }
      for (const [id, org] of state.orgs)
        if (org.stripeCustomerId === w.stripeCustomerId) return { id, ...org };
      return null;
    },
  };
  const stripeWebhookEvent = {
    create: async ({ data }: { data: { stripeEventId: string } }) => {
      if (state.ledger.has(data.stripeEventId))
        throw Object.assign(new Error("dup"), { code: "P2002" });
      state.ledger.set(data.stripeEventId, { status: "RECEIVED" });
      return {};
    },
    findUnique: async ({ where: w }: { where: { stripeEventId: string } }) => {
      const row = state.ledger.get(w.stripeEventId);
      return row ? { ...row, lastAttemptAt: new Date() } : null;
    },
    updateMany: async ({
      where: w,
      data,
    }: {
      where: { stripeEventId: string };
      data: { status: string };
    }) => {
      const row = state.ledger.get(w.stripeEventId);
      if (!row || !["RECEIVED", "FAILED"].includes(row.status)) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    },
    update: async ({
      where: w,
      data,
    }: {
      where: { stripeEventId: string };
      data: { status?: string };
    }) => {
      const row = state.ledger.get(w.stripeEventId)!;
      if (data.status) row.status = data.status;
      return {};
    },
  };
  const tx = { subscription, organization, stripeWebhookEvent };
  return {
    subscription,
    organization,
    stripeWebhookEvent,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
});

vi.mock("@/env", () => ({ getStripeEnv: () => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" }) }));
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: db }));
vi.mock("@/server/services/billing/entitlements", () => ({ invalidateEntitlements: vi.fn() }));
vi.mock("@/server/integrations/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: () => state.event },
    subscriptions: {
      retrieve: async (id: string) => structuredClone(state.stripeSubs.get(id)!),
      update: async () => ({}),
    },
  },
  planForPriceId: (price: string) => (price.startsWith("price_pro") ? "PRO" : "STARTER"),
}));

import { POST } from "@/app/api/v1/webhooks/stripe/route";

let eventSeq = 0;
async function deliver(type: string, object: Record<string, unknown>, id = `evt_${++eventSeq}`) {
  state.event = { id, type, data: { object } };
  const res = await POST(
    new Request("https://example.test/api/v1/webhooks/stripe", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "t=1,v1=fake" },
    }),
  );
  return { status: res.status, ledger: state.ledger.get(id)?.status };
}

function stripeSub(id: string, overrides: Partial<StripeSub> = {}): StripeSub {
  const sub: StripeSub = {
    id,
    customer: "cus_a",
    status: "active",
    metadata: { orgId: "org-a" },
    items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 1 }] },
    current_period_end: 1_900_000_000,
    cancel_at_period_end: false,
    trial_end: null,
    ...overrides,
  };
  state.stripeSubs.set(id, sub);
  return sub;
}

const row = (orgId = "org-a") => where(state.subs, orgId);

beforeEach(() => {
  state.orgs = new Map([
    ["org-a", { stripeCustomerId: "cus_a" }],
    ["org-b", { stripeCustomerId: "cus_b" }],
  ]);
  state.subs = new Map([
    ["org-a", { stripeSubscriptionId: "sub_new", plan: "PRO", status: "ACTIVE", seats: 1 }],
    ["org-b", { stripeSubscriptionId: "sub_b", plan: "STARTER", status: "ACTIVE", seats: 1 }],
  ]);
  state.ledger = new Map();
  state.stripeSubs = new Map();
  stripeSub("sub_new");
  stripeSub("sub_b", {
    customer: "cus_b",
    metadata: { orgId: "org-b" },
    items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 1 }] },
  });
});

describe("customer.subscription.deleted", () => {
  it("an older subscription ending never downgrades an org paying through a newer one", async () => {
    const old = stripeSub("sub_old", { status: "canceled" });
    const res = await deliver("customer.subscription.deleted", old);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
  });

  it("the current subscription ending downgrades to FREE", async () => {
    const current = stripeSub("sub_new", { status: "canceled" });
    await deliver("customer.subscription.deleted", current);
    expect(row()).toMatchObject({ stripeSubscriptionId: null, plan: "FREE", status: "CANCELED" });
  });

  it("an org with no subscription row is a completed no-op, not a retried failure", async () => {
    state.subs.delete("org-a");
    const res = await deliver(
      "customer.subscription.deleted",
      stripeSub("sub_x", { status: "canceled" }),
    );
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toBeUndefined();
  });
});

describe("invoice.payment_failed", () => {
  it("a failure on an older subscription leaves the current one ACTIVE", async () => {
    stripeSub("sub_old", { status: "past_due" });
    const res = await deliver("invoice.payment_failed", {
      id: "in_1",
      customer: "cus_a",
      subscription: "sub_old",
    });
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()!.status).toBe("ACTIVE");
  });

  it("a failure on the current subscription marks it PAST_DUE", async () => {
    stripeSub("sub_new", { status: "past_due" });
    await deliver("invoice.payment_failed", {
      id: "in_2",
      customer: "cus_a",
      subscription: "sub_new",
    });
    expect(row()!.status).toBe("PAST_DUE");
  });

  it("a one-off invoice with no subscription changes nothing", async () => {
    const res = await deliver("invoice.payment_failed", {
      id: "in_3",
      customer: "cus_a",
      subscription: null,
    });
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()!.status).toBe("ACTIVE");
  });

  it("never touches another organization's subscription", async () => {
    stripeSub("sub_b", { customer: "cus_b", metadata: { orgId: "org-b" }, status: "past_due" });
    await deliver("invoice.payment_failed", {
      id: "in_4",
      customer: "cus_a",
      subscription: "sub_b",
    });
    expect(row("org-a")!.status).toBe("ACTIVE");
    expect(row("org-b")!.status).toBe("ACTIVE");
  });
});

describe("stale or second subscriptions never replace the current one", () => {
  it("an update for an older, still-live subscription arriving late is ignored", async () => {
    const old = stripeSub("sub_old", {
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 3 }] },
    });
    const res = await deliver("customer.subscription.updated", old);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
  });

  it("invoice.paid for an older subscription doesn't switch the org to it", async () => {
    stripeSub("sub_old", {
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 1 }] },
    });
    await deliver("invoice.paid", { id: "in_5", customer: "cus_a", subscription: "sub_old" });
    expect(row()!.stripeSubscriptionId).toBe("sub_new");
    expect(row()!.plan).toBe("PRO");
  });

  it("a second checkout's subscription waits until the current one has ended", async () => {
    stripeSub("sub_second", {
      items: { data: [{ price: { id: "price_starter_annual" }, quantity: 1 }] },
    });
    await deliver("checkout.session.completed", {
      id: "cs_1",
      mode: "subscription",
      subscription: "sub_second",
      metadata: { orgId: "org-a" },
    });
    expect(row()!.stripeSubscriptionId).toBe("sub_new");

    // The current one ends; the second one's next event may now take over.
    await deliver("customer.subscription.deleted", stripeSub("sub_new", { status: "canceled" }));
    await deliver("customer.subscription.updated", state.stripeSubs.get("sub_second")!);
    expect(row()).toMatchObject({
      stripeSubscriptionId: "sub_second",
      plan: "STARTER",
      status: "ACTIVE",
    });
  });

  it("a plan change on the same subscription (Billing Portal) is applied", async () => {
    const changed = stripeSub("sub_new", {
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 2 }] },
    });
    await deliver("customer.subscription.updated", changed);
    expect(row()).toMatchObject({
      stripeSubscriptionId: "sub_new",
      plan: "STARTER",
      status: "ACTIVE",
      seats: 2,
    });
  });

  it("an INCOMPLETE subscription stays current until Stripe expires it, then a new one can replace it", async () => {
    state.subs.set("org-a", {
      stripeSubscriptionId: "sub_inc",
      plan: "PRO",
      status: "INCOMPLETE",
      seats: 1,
    });
    stripeSub("sub_inc", { status: "incomplete" });
    const retry = stripeSub("sub_retry");
    await deliver("customer.subscription.created", retry);
    expect(row()!.stripeSubscriptionId).toBe("sub_inc");

    await deliver(
      "customer.subscription.updated",
      stripeSub("sub_inc", { status: "incomplete_expired" }),
    );
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_inc", status: "CANCELED" });
    await deliver("customer.subscription.updated", retry);
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_retry", status: "ACTIVE" });
  });
});

describe("no cross-organization effect", () => {
  it("a subscription whose metadata names org B but whose customer is org A's never touches org B", async () => {
    const misattributed = stripeSub("sub_x", { customer: "cus_a", metadata: { orgId: "org-b" } });
    const res = await deliver("customer.subscription.updated", misattributed);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row("org-b")).toEqual({
      stripeSubscriptionId: "sub_b",
      plan: "STARTER",
      status: "ACTIVE",
      seats: 1,
    });
  });

  it("an unknown organization in metadata is completed without creating a row", async () => {
    const orphan = stripeSub("sub_y", { metadata: { orgId: "org-missing" } });
    const res = await deliver("customer.subscription.updated", orphan);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(state.subs.has("org-missing")).toBe(false);
  });
});

describe("idempotent retries", () => {
  it("the same event delivered twice changes the row once", async () => {
    const changed = stripeSub("sub_new", {
      items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 4 }] },
    });
    await deliver("customer.subscription.updated", changed, "evt_same");
    row()!.seats = 99; // a later legitimate change
    const again = await deliver("customer.subscription.updated", changed, "evt_same");
    expect(again.status).toBe(200);
    expect(row()!.seats).toBe(99);
  });
});
