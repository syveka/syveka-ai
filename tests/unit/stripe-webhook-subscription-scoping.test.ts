import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An organization has one subscription row, but a Stripe customer can have
 * more than one subscription over time (an older one being retired, a second
 * checkout, a stale retry). These scenarios run the real webhook route over a
 * small stateful fake of the organization, subscription and ledger tables
 * and of Stripe's current subscription state, and check the row each time:
 * only the subscription an event is about can change it, and only one that
 * may be current can become current.
 */

type FakeLine = {
  id: string;
  subscription: string | null;
  price: { id: string };
  proration: boolean;
  amount: number;
  discount_amounts: Array<{ amount: number }>;
};
type FakeInvoice = {
  id: string;
  created: number;
  customer: string;
  subscription: string;
  /** Set on a revision: the invoice it replaces. */
  from_invoice: { action: string; invoice: string } | null;
  /** Set on a revised (voided) invoice: its replacement. */
  latest_revision: string | null;
  status: string;
  billing_reason: string;
  amount_remaining: number;
  lines: FakeLine[];
};

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
  /**
   * Stripe's invoices (listed newest first by `created`): subscription,
   * status, billing reason, amount_remaining (already net of discounts,
   * credits and balance) and line items, the first page inline.
   */
  invoices: [] as FakeInvoice[],
  /** Each subscription's upcoming invoice; none → Stripe's invoice_upcoming_none. */
  upcoming: new Map<string, { amount_due: number; lines: FakeLine[] }>(),
  /** The customer's pending invoice items (not yet on any invoice). */
  pendingItems: [] as Array<{ id: string; customer: string; subscription: string; amount: number }>,
  /** Line items per page: everything after the first `linesPerPage` is on later pages. */
  linesPerPage: 100,
  /** Every invoice read fails, as when Stripe can't be reached. */
  stripeReadsFail: false,
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
    invoices: {
      list: async ({ subscription, limit }: { subscription: string; limit: number }) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        const all = state.invoices
          .filter((i) => i.subscription === subscription)
          .sort((x, y) => y.created - x.created);
        return {
          data: all.slice(0, limit).map((i) => ({ ...structuredClone(i), lines: page(i.lines) })),
          has_more: all.length > limit,
        };
      },
      retrieve: async (id: string) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        const invoice = state.invoices.find((i) => i.id === id)!;
        return { ...structuredClone(invoice), lines: page(invoice.lines) };
      },
      listLineItems: async (id: string, { starting_after }: { starting_after: string }) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        return page(state.invoices.find((i) => i.id === id)!.lines, starting_after);
      },
      retrieveUpcoming: async ({ subscription }: { subscription: string }) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        const upcoming = state.upcoming.get(subscription);
        if (!upcoming) {
          throw Object.assign(new Error("No upcoming invoices"), { code: "invoice_upcoming_none" });
        }
        return { amount_due: upcoming.amount_due, lines: page(upcoming.lines) };
      },
      listUpcomingLines: async ({
        subscription,
        starting_after,
      }: {
        subscription: string;
        starting_after: string;
      }) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        return page(state.upcoming.get(subscription)!.lines, starting_after);
      },
    },
    invoiceItems: {
      list: async ({ customer, pending }: { customer: string; pending: boolean }) => {
        if (state.stripeReadsFail) throw new Error("Stripe unavailable");
        return {
          data: pending ? state.pendingItems.filter((i) => i.customer === customer) : [],
          has_more: false,
        };
      },
    },
  },
  // Like the real map: only configured prices have a plan.
  planForPriceId: (price: string) =>
    price.startsWith("price_pro") ? "PRO" : price.startsWith("price_starter") ? "STARTER" : null,
}));

import { POST } from "@/app/api/v1/webhooks/stripe/route";

/** One page of line items, Stripe-style: after `startingAfter`, at most `linesPerPage`. */
function page(lines: FakeLine[], startingAfter?: string) {
  const from = startingAfter ? lines.findIndex((l) => l.id === startingAfter) + 1 : 0;
  const data = lines.slice(from, from + state.linesPerPage).map((l) => structuredClone(l));
  return { data, has_more: from + state.linesPerPage < lines.length };
}

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

let warn: ReturnType<typeof vi.spyOn>;
/** The structured alerts the route raised, parsed. */
function alerts(): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes('"alert"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => warn.mockRestore());

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
  state.invoices = [];
  state.upcoming = new Map();
  state.pendingItems = [];
  state.linesPerPage = 100;
  state.stripeReadsFail = false;
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
    expect(alerts()).toEqual([
      expect.objectContaining({ reason: "other_subscription_current", subscriptionId: "sub_old" }),
    ]);
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

  it("an ACTIVE subscription doesn't replace another ACTIVE current one, and raises a safe alert", async () => {
    stripeSub("sub_second", {
      items: { data: [{ price: { id: "price_starter_annual" }, quantity: 1 }] },
    });
    await deliver("customer.subscription.updated", state.stripeSubs.get("sub_second")!);
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
    expect(alerts()).toEqual([
      {
        alert: "stripe_subscription_event_skipped",
        reason: "other_subscription_current",
        organizationId: "org-a",
        subscriptionId: "sub_second",
        subscriptionStatus: "active",
        currentSubscriptionId: "sub_new",
        currentStatus: "ACTIVE",
      },
    ]);
  });

  it.each(["TRIALING", "PAST_DUE", "PAUSED"])(
    "a second ACTIVE subscription doesn't replace a current %s one",
    async (status) => {
      row()!.status = status;
      await deliver("customer.subscription.created", stripeSub("sub_second"));
      expect(row()).toMatchObject({ stripeSubscriptionId: "sub_new", status });
      expect(alerts()).toHaveLength(1);
    },
  );
});

describe("a paying subscription replaces a current one that never paid (INCOMPLETE)", () => {
  beforeEach(() => {
    state.subs.set("org-a", {
      stripeSubscriptionId: "sub_inc",
      plan: "PRO",
      status: "INCOMPLETE",
      seats: 1,
    });
    stripeSub("sub_inc", { status: "incomplete" });
  });

  it.each(["active", "trialing"])("a %s subscription takes over immediately", async (status) => {
    const paying = stripeSub("sub_paid", {
      status,
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 2 }] },
    });
    const res = await deliver("customer.subscription.created", paying);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toMatchObject({
      stripeSubscriptionId: "sub_paid",
      plan: "STARTER",
      status: status.toUpperCase(),
      seats: 2,
    });
    expect(alerts()).toEqual([]);
  });

  it("through checkout.session.completed and invoice.paid as well", async () => {
    stripeSub("sub_paid");
    await deliver("checkout.session.completed", {
      id: "cs_2",
      mode: "subscription",
      subscription: "sub_paid",
      metadata: { orgId: "org-a" },
    });
    expect(row()!.stripeSubscriptionId).toBe("sub_paid");

    state.subs.get("org-a")!.stripeSubscriptionId = "sub_inc";
    state.subs.get("org-a")!.status = "INCOMPLETE";
    await deliver("invoice.paid", { id: "in_9", customer: "cus_a", subscription: "sub_paid" });
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_paid", status: "ACTIVE" });
  });

  it("the old INCOMPLETE one expiring later changes nothing", async () => {
    await deliver("customer.subscription.created", stripeSub("sub_paid"));
    await deliver(
      "customer.subscription.updated",
      stripeSub("sub_inc", { status: "incomplete_expired" }),
    );
    await deliver(
      "customer.subscription.deleted",
      stripeSub("sub_inc", { status: "incomplete_expired" }),
    );
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_paid", status: "ACTIVE" });
  });

  // Review finding (#342): invoice.payment_failed used to accept an
  // `incomplete` subscription, turn the row PAST_DUE (which keeps the paid
  // plan's limits, see entitlements.ts PAYING_STATUSES) and, because PAST_DUE
  // is not supersedable, block the customer's next successful checkout.
  it("a failed FIRST payment leaves it INCOMPLETE: no PAST_DUE, so no paid limits", async () => {
    const res = await deliver("invoice.payment_failed", {
      id: "in_first_fail",
      customer: "cus_a",
      subscription: "sub_inc",
    });
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_inc",
      plan: "PRO",
      status: "INCOMPLETE",
      seats: 1,
    });
    expect(alerts()).toEqual([]);
  });

  it("after a failed first payment, the customer's next paying subscription becomes current", async () => {
    await deliver("invoice.payment_failed", {
      id: "in_first_fail",
      customer: "cus_a",
      subscription: "sub_inc",
    });
    const paying = stripeSub("sub_paid", {
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 2 }] },
    });
    await deliver("customer.subscription.created", paying);
    expect(row()).toMatchObject({
      stripeSubscriptionId: "sub_paid",
      plan: "STARTER",
      status: "ACTIVE",
    });
    expect(alerts()).toEqual([]);
  });

  it("an ESTABLISHED subscription's failed renewal still goes PAST_DUE and keeps its place", async () => {
    state.subs.set("org-a", {
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
    stripeSub("sub_new", { status: "past_due" });
    await deliver("invoice.payment_failed", {
      id: "in_renewal_fail",
      customer: "cus_a",
      subscription: "sub_new",
    });
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_new", status: "PAST_DUE" });
    // Dunning in progress: a second checkout does not silently replace it.
    await deliver("customer.subscription.created", stripeSub("sub_second"));
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_new", status: "PAST_DUE" });
    expect(alerts()).toEqual([
      expect.objectContaining({ reason: "other_subscription_current", currentStatus: "PAST_DUE" }),
    ]);
  });

  it("another subscription that isn't paying either doesn't replace it (and alerts)", async () => {
    await deliver("customer.subscription.created", stripeSub("sub_inc2", { status: "incomplete" }));
    expect(row()).toMatchObject({ stripeSubscriptionId: "sub_inc", status: "INCOMPLETE" });
    expect(alerts()).toEqual([
      expect.objectContaining({
        reason: "other_subscription_current",
        subscriptionId: "sub_inc2",
        subscriptionStatus: "incomplete",
        currentStatus: "INCOMPLETE",
      }),
    ]);
  });

  it("a paying subscription of another customer never replaces it", async () => {
    await deliver(
      "customer.subscription.created",
      stripeSub("sub_foreign", { customer: "cus_other" }),
    );
    expect(row()!.stripeSubscriptionId).toBe("sub_inc");
    expect(alerts()).toEqual([
      {
        alert: "stripe_subscription_event_skipped",
        reason: "customer_mismatch",
        organizationId: "org-a",
        subscriptionId: "sub_foreign",
        subscriptionStatus: "active",
      },
    ]);
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
    expect(alerts()).toEqual([
      expect.objectContaining({
        reason: "customer_mismatch",
        organizationId: "org-b",
        subscriptionId: "sub_x",
      }),
    ]);
    // Ids and statuses only.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/cus_a|price_|metadata/);
  });

  // Review finding (#342): the ownership check used to pass when the org had
  // no stored Stripe customer, trusting the subscription's metadata alone.
  it("an org with no stored Stripe customer is never written on metadata alone (fail closed)", async () => {
    state.orgs.set("org-a", { stripeCustomerId: null });
    const changed = stripeSub("sub_new", {
      items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 7 }] },
    });
    const res = await deliver("customer.subscription.updated", changed);
    expect(res).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
    expect(alerts()).toEqual([
      expect.objectContaining({
        reason: "customer_mismatch",
        organizationId: "org-a",
        subscriptionId: "sub_new",
      }),
    ]);
  });

  it("a subscription without a customer is never written either", async () => {
    const orphan = stripeSub("sub_new", {
      customer: "" as never,
      items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 7 }] },
    });
    await deliver("customer.subscription.updated", orphan);
    expect(row()!.seats).toBe(1);
    expect(alerts()).toEqual([expect.objectContaining({ reason: "customer_mismatch" })]);
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

describe("Starter → Pro is granted only once what the change owes is paid", () => {
  // Org B: Starter monthly on sub_b. Each test sets the state Stripe reports
  // after the customer confirmed Pro in the portal.
  const pro = (overrides: Partial<StripeSub> = {}) =>
    stripeSub("sub_b", {
      customer: "cus_b",
      metadata: { orgId: "org-b" },
      items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 1 }] },
      ...overrides,
    });
  let seq = 0;
  let clock = 1_000;
  const line = (
    price: string,
    amount: number,
    opts: { proration?: boolean; sub?: string | null; discount?: number } = {},
  ): FakeLine => ({
    id: `il_${++seq}`,
    subscription: opts.sub === undefined ? "sub_b" : opts.sub,
    price: { id: price },
    proration: opts.proration ?? false,
    amount,
    discount_amounts: opts.discount ? [{ amount: opts.discount }] : [],
  });
  /** Adds or updates an invoice; a new one is the newest unless `created` says otherwise. */
  const invoice = (
    id: string,
    status: string,
    amount_remaining: number,
    lines: FakeLine[] = [],
    opts: {
      reason?: string;
      created?: number;
      fromInvoice?: string;
      action?: string;
      customer?: string;
    } = {},
  ) => {
    const existing = state.invoices.find((i) => i.id === id);
    if (existing) return Object.assign(existing, { status, amount_remaining });
    state.invoices.push({
      id,
      created: opts.created ?? ++clock,
      customer: opts.customer ?? "cus_b",
      subscription: "sub_b",
      from_invoice: opts.fromInvoice
        ? { action: opts.action ?? "revision", invoice: opts.fromInvoice }
        : null,
      latest_revision: null,
      status,
      billing_reason: opts.reason ?? "subscription_cycle",
      amount_remaining,
      lines,
    });
  };
  /** The proration invoice of Starter → Pro monthly, charged when the change is made. */
  const changeLines = () => [
    line("price_starter_monthly", -2000, { proration: true }),
    line("price_pro_monthly", 5000, { proration: true }),
  ];
  const changeInvoice = (id: string, status: string, amount_remaining: number) =>
    invoice(id, status, amount_remaining, changeLines(), { reason: "subscription_update" });
  /**
   * Stripe's "Revise invoice" on a voided one: a new invoice whose
   * from_invoice points back, and the original's latest_revision forward.
   */
  const revise = (
    original: string,
    id: string,
    status: string,
    amount_remaining: number,
    opts: { lines?: FakeLine[]; action?: string; customer?: string } = {},
  ) => {
    invoice(id, status, amount_remaining, opts.lines ?? changeLines(), {
      reason: "manual",
      fromInvoice: original,
      action: opts.action,
      customer: opts.customer,
    });
    state.invoices.find((i) => i.id === original)!.latest_revision = id;
  };
  const voidAlert = (replacement: string) => ({
    alert: "stripe_plan_raise_on_void_invoice",
    subscriptionId: "sub_b",
    invoiceId: "in_change",
    replacement,
  });
  const updated = (id?: string) =>
    deliver("customer.subscription.updated", structuredClone(state.stripeSubs.get("sub_b")!), id);
  const paid = (invoiceId: string, id?: string) =>
    deliver("invoice.paid", { id: invoiceId, subscription: "sub_b", customer: "cus_b" }, id);
  const held = (reason: string) => ({
    alert: "stripe_plan_raise_deferred_unpaid",
    organizationId: "org-b",
    subscriptionId: "sub_b",
    subscriptionStatus: state.stripeSubs.get("sub_b")!.status,
    reason,
  });
  const plan = () => row("org-b")!.plan;

  beforeEach(() => {
    // October's Starter renewal, paid: the last invoice before the change.
    invoice("in_oct", "paid", 0, [line("price_starter_monthly", 2900)]);
  });

  it("charged at once and paid → Pro", async () => {
    changeInvoice("in_change", "paid", 0);
    pro();
    expect(await updated()).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(row("org-b")).toMatchObject({ plan: "PRO", status: "ACTIVE" });
    expect(alerts()).toEqual([]);
  });

  it("charged at once, payment still open (processing or 3-D Secure) → Starter, then Pro when that invoice is paid", async () => {
    changeInvoice("in_change", "open", 3000);
    pro();
    await updated();
    expect(row("org-b")).toMatchObject({ plan: "STARTER", status: "ACTIVE" });
    expect(alerts()).toContainEqual(held("invoice_unpaid"));

    changeInvoice("in_change", "paid", 0);
    await paid("in_change");
    expect(plan()).toBe("PRO");
  });

  it("failed payment, out-of-order events, then the matching invoice paid → Starter until then, then Pro", async () => {
    changeInvoice("in_change", "open", 3000);
    pro({ status: "past_due" });
    await updated();
    expect(row("org-b")).toMatchObject({ plan: "STARTER", status: "PAST_DUE" });
    expect(alerts()).toContainEqual(held("subscription_unpaid"));

    // A late retry of October's invoice.paid, with Stripe back to active
    // while the change's invoice is still owed: October's payment proves
    // nothing about the change.
    state.stripeSubs.get("sub_b")!.status = "active";
    await paid("in_oct");
    expect(plan()).toBe("STARTER");
    expect(alerts()).toContainEqual(held("invoice_unpaid"));
    // A late retry of the failure itself: nothing changes.
    await deliver("invoice.payment_failed", {
      id: "in_change",
      subscription: "sub_b",
      customer: "cus_b",
    });
    expect(plan()).toBe("STARTER");

    changeInvoice("in_change", "paid", 0);
    await paid("in_change");
    expect(row("org-b")).toMatchObject({ plan: "PRO", status: "ACTIVE" });
  });

  it("an uncollectible invoice for the change keeps Starter", async () => {
    changeInvoice("in_change", "uncollectible", 3000);
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
  });

  it("an old unpaid renewal (uncollectible, or a draft that never finalized) doesn't block a paid change", async () => {
    invoice("in_sep", "uncollectible", 2900, [line("price_starter_monthly", 2900)], {
      created: 10,
    });
    invoice("in_aug_draft", "draft", 2900, [line("price_starter_monthly", 2900)], { created: 5 });
    changeInvoice("in_change", "paid", 0);
    pro();
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("an old paid upgrade invoice (an earlier Pro period) never stands in for this change's", async () => {
    // August: Starter → Pro, paid. Later downgraded; October billed Starter.
    invoice("in_aug_upgrade", "paid", 0, [line("price_pro_monthly", 5000, { proration: true })], {
      reason: "subscription_update",
      created: 5,
    });
    // Now: Starter → Pro again, its invoice still open.
    changeInvoice("in_change", "open", 3000);
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
  });

  it("an old unpaid upgrade invoice from before the last Starter renewal doesn't block a change with nothing due", async () => {
    invoice(
      "in_aug_upgrade",
      "uncollectible",
      5000,
      [line("price_pro_monthly", 5000, { proration: true })],
      { reason: "subscription_update", created: 5 },
    );
    pro();
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("deferred to a later invoice: upcoming, then in a draft, then paid → Starter, Starter, Pro", async () => {
    // The portal applied the change and left the proration for the next
    // invoice: active on Pro, the amount sitting on the upcoming invoice.
    const prorations = [
      line("price_starter_monthly", -2000, { proration: true }),
      line("price_pro_monthly", 5000, { proration: true }),
    ];
    state.upcoming.set("sub_b", {
      amount_due: 10900,
      lines: [...prorations, line("price_pro_monthly", 7900)],
    });
    pro();
    await updated();
    expect(row("org-b")).toMatchObject({ plan: "STARTER", status: "ACTIVE" });
    expect(alerts()).toContainEqual(held("deferred_amount_due"));

    // November's renewal takes the prorations as a draft: still owed.
    state.upcoming.set("sub_b", { amount_due: 7900, lines: [line("price_pro_monthly", 7900)] });
    invoice("in_nov", "draft", 10900, [...prorations, line("price_pro_monthly", 7900)]);
    await updated();
    expect(plan()).toBe("STARTER");
    expect(alerts()).toContainEqual(held("invoice_unpaid"));

    invoice("in_nov", "paid", 0);
    await paid("in_nov");
    expect(plan()).toBe("PRO");
  });

  it("deferred, but discounts or customer credit mean nothing will be charged → Pro", async () => {
    pro();
    // A 100% discount on the proration line.
    state.upcoming.set("sub_b", {
      amount_due: 0,
      lines: [line("price_pro_monthly", 5000, { proration: true, discount: 5000 })],
    });
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("deferred, customer credit covers the whole upcoming invoice → Pro", async () => {
    pro();
    state.upcoming.set("sub_b", {
      amount_due: 0, // after the customer's credit balance
      lines: [
        line("price_pro_monthly", 5000, { proration: true }),
        line("price_pro_monthly", 7900),
      ],
    });
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("another subscription's lines neither unlock nor hold this one", async () => {
    pro();
    // Another subscription's large credit doesn't offset what this change owes.
    state.upcoming.set("sub_b", {
      amount_due: 5000,
      lines: [
        line("price_pro_monthly", 5000, { proration: true }),
        line("price_starter_monthly", -90000, { proration: true, sub: "sub_other" }),
      ],
    });
    await updated();
    expect(plan()).toBe("STARTER");

    // And another subscription's proration owed doesn't hold this one.
    state.upcoming.set("sub_b", {
      amount_due: 5000,
      lines: [line("price_pro_monthly", 5000, { proration: true, sub: "sub_other" })],
    });
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("zero due after discounts on the change's invoice → Pro", async () => {
    invoice(
      "in_change",
      "open",
      0,
      [line("price_pro_monthly", 5000, { proration: true, discount: 5000 })],
      { reason: "subscription_update" },
    );
    pro();
    await updated();
    expect(plan()).toBe("PRO");
    expect(alerts()).toEqual([]);
  });

  it("nothing due (no proration) → Pro as soon as Stripe reports the change, not before", async () => {
    await updated();
    expect(plan()).toBe("STARTER");
    pro();
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("monthly Starter → annual Pro: the new period invoiced at once must be paid", async () => {
    invoice(
      "in_annual",
      "open",
      77000,
      [line("price_starter_monthly", -2000, { proration: true }), line("price_pro_annual", 79000)],
      { reason: "subscription_update" },
    );
    pro({ items: { data: [{ price: { id: "price_pro_annual" }, quantity: 3 }] } });
    await updated();
    expect(plan()).toBe("STARTER");

    invoice("in_annual", "paid", 0);
    await paid("in_annual");
    expect(row("org-b")).toMatchObject({ plan: "PRO", seats: 3 });
  });

  it("the change's invoice lines span several pages → read in full", async () => {
    state.linesPerPage = 1;
    // The Pro proration line is on the second page.
    changeInvoice("in_change", "open", 3000);
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
    changeInvoice("in_change", "paid", 0);
    await paid("in_change");
    expect(plan()).toBe("PRO");
  });

  it("a deferred proration on a later page of the upcoming invoice is still seen", async () => {
    state.linesPerPage = 1;
    state.upcoming.set("sub_b", {
      amount_due: 12900,
      lines: [
        line("price_pro_monthly", 7900),
        line("price_pro_monthly", 5000, { proration: true }),
      ],
    });
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
  });

  it("deferred, then set to cancel (no upcoming invoice): the pending proration still holds Pro", async () => {
    state.pendingItems = [
      { id: "ii_1", customer: "cus_b", subscription: "sub_b", amount: -2000 },
      { id: "ii_2", customer: "cus_b", subscription: "sub_b", amount: 5000 },
      { id: "ii_3", customer: "cus_b", subscription: "sub_other", amount: -90000 },
    ];
    pro({ cancel_at_period_end: true });
    await updated();
    expect(row("org-b")).toMatchObject({ plan: "STARTER", cancelAtPeriodEnd: true });
    expect(alerts()).toContainEqual(held("deferred_amount_due"));
  });

  it("set to cancel with nothing pending for this subscription → the change applies", async () => {
    state.pendingItems = [
      { id: "ii_9", customer: "cus_b", subscription: "sub_other", amount: 5000 },
    ];
    pro({ cancel_at_period_end: true });
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("a newer paid seat-change on Pro never stands in for the upgrade's open invoice", async () => {
    changeInvoice("in_change", "open", 3000);
    // Seats added later on Pro: a Pro-only proration, paid.
    invoice("in_seats", "paid", 0, [line("price_pro_monthly", 2500, { proration: true })], {
      reason: "subscription_update",
    });
    pro({ items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 2 }] } });
    await updated();
    expect(plan()).toBe("STARTER");
  });

  it("a legacy Starter price: the change is still recognised, and history past it isn't needed", async () => {
    // Eleven renewals on a legacy price no plan maps to, then the change.
    state.invoices = [];
    for (let n = 1; n <= 11; n++) {
      invoice(`in_legacy_${n}`, "paid", 0, [line("price_legacy_3999", 3999)]);
    }
    invoice(
      "in_change",
      "open",
      4000,
      [
        line("price_legacy_3999", -2000, { proration: true }),
        line("price_pro_monthly", 6000, { proration: true }),
      ],
      { reason: "subscription_update" },
    );
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
    expect(alerts()).toContainEqual(held("invoice_unpaid"));

    invoice("in_change", "paid", 0);
    await paid("in_change");
    expect(plan()).toBe("PRO");
  });

  it("a legacy price with nothing charged at once: the last regular period ends the search → Pro", async () => {
    state.invoices = [];
    for (let n = 1; n <= 11; n++) {
      invoice(`in_legacy_${n}`, "paid", 0, [line("price_legacy_3999", 3999)]);
    }
    pro();
    await updated();
    expect(plan()).toBe("PRO");
  });

  it("history that can't be placed (no regular period among the newest) holds, with an alert", async () => {
    state.invoices = [];
    for (let n = 1; n <= 11; n++) {
      invoice(`in_oneoff_${n}`, "paid", 0, [], { reason: "manual" });
    }
    pro();
    await updated();
    expect(plan()).toBe("STARTER");
    expect(alerts()).toContainEqual({
      alert: "stripe_plan_raise_history_unreadable",
      subscriptionId: "sub_b",
      what: "invoices",
    });
  });

  describe("the change's invoice was voided", () => {
    beforeEach(() => {
      changeInvoice("in_change", "void", 3000);
      pro();
    });

    it("no replacement → Starter, with the alert", async () => {
      await updated();
      expect(plan()).toBe("STARTER");
      expect(alerts()).toContainEqual(voidAlert("none"));
      expect(alerts()).toContainEqual(held("invoice_voided"));
    });

    it("a replacement (revision) still unpaid → Starter", async () => {
      revise("in_change", "in_change_r1", "open", 3000);
      await updated();
      expect(plan()).toBe("STARTER");
      expect(alerts()).toContainEqual(voidAlert("unpaid"));
    });

    it("the matching replacement paid → Pro, and the alert stays", async () => {
      revise("in_change", "in_change_r1", "open", 3000);
      await updated();
      expect(plan()).toBe("STARTER");

      invoice("in_change_r1", "paid", 0);
      await paid("in_change_r1");
      expect(plan()).toBe("PRO");
      expect(alerts()).toContainEqual(voidAlert("paid"));
    });

    it("a replacement that was itself voided and revised again → Pro only once the last one is paid", async () => {
      revise("in_change", "in_change_r1", "void", 3000);
      revise("in_change_r1", "in_change_r2", "open", 3000);
      await updated();
      expect(plan()).toBe("STARTER");
      invoice("in_change_r2", "paid", 0);
      await updated();
      expect(plan()).toBe("PRO");
    });

    it("an unrelated paid invoice never unlocks it: a one-off charge or a later Pro renewal", async () => {
      invoice("in_oneoff", "paid", 0, [line("price_setup_fee", 5000, { sub: null })], {
        reason: "manual",
      });
      invoice("in_dec", "paid", 0, [line("price_pro_monthly", 7900)]);
      await paid("in_oneoff");
      await paid("in_dec");
      expect(plan()).toBe("STARTER");
      expect(alerts()).toContainEqual(voidAlert("none"));
    });

    it("a paid invoice that claims to replace another invoice, or no longer carries the change, doesn't count", async () => {
      // Linked from the voided one, but its from_invoice points elsewhere.
      revise("in_change", "in_other_r1", "paid", 0);
      state.invoices.find((i) => i.id === "in_other_r1")!.from_invoice = {
        action: "revision",
        invoice: "in_oct",
      };
      await updated();
      expect(plan()).toBe("STARTER");
      expect(alerts()).toContainEqual(voidAlert("unlinked"));

      // A real revision, but rewritten to a flat charge without the change.
      state.invoices = state.invoices.filter((i) => i.id !== "in_other_r1");
      revise("in_change", "in_flat_r1", "paid", 0, { lines: [line("price_setup_fee", 3000)] });
      await updated();
      expect(plan()).toBe("STARTER");

      // A revision for another customer.
      state.invoices = state.invoices.filter((i) => i.id !== "in_flat_r1");
      revise("in_change", "in_foreign_r1", "paid", 0, { customer: "cus_a" });
      await updated();
      expect(plan()).toBe("STARTER");
    });

    it("Stripe can't read the replacement → the event fails, Starter stays; the retry decides", async () => {
      revise("in_change", "in_change_r1", "paid", 0);
      state.stripeReadsFail = true;
      expect(await updated("evt_void")).toEqual({ status: 500, ledger: "FAILED" });
      expect(plan()).toBe("STARTER");
      state.stripeReadsFail = false;
      expect(await updated("evt_void")).toEqual({ status: 200, ledger: "COMPLETED" });
      expect(plan()).toBe("PRO");
    });
  });

  it("checkout.session.completed for the same subscription follows the same rule", async () => {
    changeInvoice("in_change", "open", 3000);
    pro();
    await deliver("checkout.session.completed", {
      id: "cs_1",
      mode: "subscription",
      subscription: "sub_b",
      metadata: { orgId: "org-b" },
    });
    expect(plan()).toBe("STARTER");
  });

  it("an older update event delivered after the paid upgrade can't take Pro away", async () => {
    changeInvoice("in_change", "paid", 0);
    const stale = structuredClone(
      stripeSub("sub_b", { customer: "cus_b", metadata: { orgId: "org-b" } }),
    );
    pro();
    await updated("evt_upgrade");
    expect(plan()).toBe("PRO");
    // Stripe's current state is applied, not the stale event's Starter copy.
    await deliver("customer.subscription.updated", stale, "evt_older");
    expect(plan()).toBe("PRO");
  });

  it("Stripe can't be read → the event fails and Starter stays; the retry reconciles to Pro", async () => {
    changeInvoice("in_change", "paid", 0);
    pro();
    state.stripeReadsFail = true;
    expect(await updated("evt_upgrade")).toEqual({ status: 500, ledger: "FAILED" });
    expect(row("org-b")).toMatchObject({ plan: "STARTER", status: "ACTIVE" });

    // Stripe's retry of the same event, once reads work again.
    state.stripeReadsFail = false;
    expect(await updated("evt_upgrade")).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(plan()).toBe("PRO");
    // A further duplicate delivery is a no-op.
    expect(await updated("evt_upgrade")).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(plan()).toBe("PRO");
  });

  it("the retry still holds when the change's payment remains owed", async () => {
    changeInvoice("in_change", "open", 3000);
    pro();
    state.stripeReadsFail = true;
    await updated("evt_upgrade");
    state.stripeReadsFail = false;
    await updated("evt_upgrade");
    expect(plan()).toBe("STARTER");
  });

  it("the row changing between the payment check and the write → the event fails, the retry decides", async () => {
    // When the check runs the row is already PRO (an earlier delivery), and
    // a concurrent event puts it back to Starter before this event's write.
    pro();
    row("org-b")!.plan = "PRO";
    const findUnique = db.subscription.findUnique;
    let reads = 0;
    db.subscription.findUnique = async (args) => {
      // A real read returns a snapshot, not the live row.
      const result = structuredClone(await findUnique(args));
      if (++reads === 1) state.subs.get("org-b")!.plan = "STARTER";
      return result;
    };
    try {
      expect(await updated("evt_race")).toEqual({ status: 500, ledger: "FAILED" });
      expect(plan()).toBe("STARTER");
    } finally {
      db.subscription.findUnique = findUnique;
    }
    // The retry checks against the row as it is now, and nothing is owed.
    expect(await updated("evt_race")).toEqual({ status: 200, ledger: "COMPLETED" });
    expect(plan()).toBe("PRO");
  });

  it("a renewal failing on the plan the org already has keeps that plan (dunning), without reads", async () => {
    state.stripeReadsFail = true;
    stripeSub("sub_new", { status: "past_due" });
    await deliver(
      "customer.subscription.updated",
      structuredClone(state.stripeSubs.get("sub_new")!),
    );
    expect(row()).toMatchObject({ plan: "PRO", status: "PAST_DUE" });
    expect(alerts()).toEqual([]);
  });

  it("a downgrade applies at once, even while past_due and with Stripe unreadable", async () => {
    state.stripeReadsFail = true;
    stripeSub("sub_new", {
      status: "past_due",
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 1 }] },
    });
    await deliver(
      "customer.subscription.updated",
      structuredClone(state.stripeSubs.get("sub_new")!),
    );
    expect(row()).toMatchObject({ plan: "STARTER", status: "PAST_DUE" });
  });
});

describe("a cancellation at period end, and its reversal", () => {
  it("is stored with its date; plan and status stay until the period ends", async () => {
    stripeSub("sub_new", { cancel_at_period_end: true, current_period_end: 1_796_256_000 });
    await deliver(
      "customer.subscription.updated",
      structuredClone(state.stripeSubs.get("sub_new")!),
    );
    expect(row()).toMatchObject({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(1_796_256_000 * 1000),
    });
  });

  it("renewing clears it, and a late retry of the cancel event can't bring it back", async () => {
    const cancelled = stripeSub("sub_new", { cancel_at_period_end: true });
    const cancelEvent = structuredClone(cancelled);
    await deliver("customer.subscription.updated", cancelEvent, "evt_cancel");
    expect(row()).toMatchObject({ cancelAtPeriodEnd: true });

    stripeSub("sub_new", { cancel_at_period_end: false });
    await deliver(
      "customer.subscription.updated",
      structuredClone(state.stripeSubs.get("sub_new")!),
      "evt_renew",
    );
    expect(row()).toMatchObject({ plan: "PRO", status: "ACTIVE", cancelAtPeriodEnd: false });

    // The same cancel event again: a duplicate, nothing changes.
    expect(await deliver("customer.subscription.updated", cancelEvent, "evt_cancel")).toEqual({
      status: 200,
      ledger: "COMPLETED",
    });
    // An older event (another id) with the cancelled copy, delivered out of
    // order: Stripe's current state is applied, not the event's copy.
    await deliver("customer.subscription.updated", cancelEvent, "evt_cancel_older");
    expect(row()).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it("a cancellation event for another org's subscription never touches this org", async () => {
    stripeSub("sub_b", {
      customer: "cus_b",
      metadata: { orgId: "org-b" },
      items: { data: [{ price: { id: "price_starter_monthly" }, quantity: 1 }] },
      cancel_at_period_end: true,
    });
    await deliver("customer.subscription.updated", structuredClone(state.stripeSubs.get("sub_b")!));
    expect(row("org-b")).toMatchObject({ cancelAtPeriodEnd: true });
    expect(row()).toEqual({
      stripeSubscriptionId: "sub_new",
      plan: "PRO",
      status: "ACTIVE",
      seats: 1,
    });
  });
});
