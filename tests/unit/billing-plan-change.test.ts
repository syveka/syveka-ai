import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Starting or changing a paid plan (startPlanChange) and opening the Billing
 * Portal (openBillingPortal) with the real Stripe integration helpers over a
 * stateful fake Stripe API (customers, subscriptions, invoices, Checkout and
 * Billing Portal sessions, idempotency keys, slow responses, refused
 * expirations), a fake organization/subscription table and a fake Redis with
 * expiring keys. No live Stripe call.
 *
 * Checks that an organization with any existing subscription is sent to the
 * Billing Portal (or its first invoice) instead of a second Checkout, that
 * two tabs, a double click or a Stripe call slower than the claim can't leave
 * two usable Checkouts, that the Stripe customer is created once per
 * organization, and that nothing touches another organization.
 */

type Org = {
  name: string;
  stripeCustomerId: string | null;
  subscription: { stripeSubscriptionId: string | null; status: string } | null;
  members: number;
};
type Session = {
  id: string;
  customer: string;
  status: "open" | "expired" | "complete";
  url: string;
  created: number;
  expires_at: number;
  metadata: Record<string, string>;
};

const s = vi.hoisted(() => ({
  orgs: new Map<string, Org>(),
  customers: [] as Array<{ id: string; orgId: string }>,
  idempotency: new Map<string, unknown>(),
  stripeSubs: new Map<string, Array<{ id: string; status: string }>>(),
  invoices: new Map<string, { status: string; hosted_invoice_url: string | null }>(),
  sessions: [] as Session[],
  locks: new Map<string, { value: string; expiresAt: number }>(),
  redisDown: false,
  redisDownOnRenew: false,
  lockAlwaysFree: false,
  limited: null as null | "rate_limited" | "service_unavailable",
  /** Per Stripe method: how long its response takes (ms). */
  delay: {} as Record<string, number>,
  /** Session ids whose expire call Stripe refuses, with the state it then reports. */
  expireRefused: new Map<string, "open" | "complete">(),
  /** Simulates another request storing a different customer first. */
  storeRace: null as string | null,
  /** Runs inside Checkout creation, once Stripe has the request. */
  onCreate: null as null | (() => void),
  calls: { customersCreate: 0, sessionsCreate: 0, portal: 0 },
  createOptions: [] as Array<Record<string, unknown>>,
  clock: 1_800_000_000,
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function respond(method: string) {
  await sleep(s.delay[method] ?? 0);
}

function idempotent<T>(key: string | undefined, make: () => T): T {
  if (key && s.idempotency.has(key)) return s.idempotency.get(key) as T;
  const value = make();
  if (key) s.idempotency.set(key, value);
  return value;
}

vi.mock("stripe", () => ({
  default: class FakeStripe {
    customers = {
      create: async (
        params: { metadata: { orgId: string } },
        opts?: { idempotencyKey?: string },
      ) => {
        const customer = idempotent(opts?.idempotencyKey, () => {
          s.calls.customersCreate++;
          const c = { id: `cus_${s.customers.length + 1}`, orgId: params.metadata.orgId };
          s.customers.push(c);
          return { id: c.id };
        });
        await respond("customers.create");
        return customer;
      },
    };
    subscriptions = {
      list: async ({ customer }: { customer: string }) => {
        await respond("subscriptions.list");
        return { data: s.stripeSubs.get(customer) ?? [] };
      },
      retrieve: async (id: string) => {
        await respond("subscriptions.retrieve");
        return { id, latest_invoice: s.invoices.get(id) ?? null };
      },
    };
    checkout = {
      sessions: {
        list: async ({ customer, status }: { customer: string; status: string }) => {
          await respond("sessions.list");
          return {
            data: s.sessions
              .filter((x) => x.customer === customer && x.status === status)
              .map((x) => ({ ...x })),
          };
        },
        expire: async (id: string) => {
          await respond("sessions.expire");
          const session = s.sessions.find((x) => x.id === id)!;
          const refused = s.expireRefused.get(id);
          if (refused) {
            session.status = refused;
            throw new Error("This Checkout Session is not in an expirable state");
          }
          if (session.status !== "open") throw new Error("not open");
          session.status = "expired";
          return session;
        },
        retrieve: async (id: string) => {
          await respond("sessions.retrieve");
          return { ...s.sessions.find((x) => x.id === id)! };
        },
        create: async (
          params: { customer: string; metadata: Record<string, string> },
          opts?: Record<string, unknown> & { idempotencyKey?: string },
        ) => {
          s.createOptions.push({ ...opts });
          // Stripe creates the session when it receives the request; only
          // the response is slow.
          const session = idempotent(opts?.idempotencyKey, () => {
            s.calls.sessionsCreate++;
            const id = `cs_${s.sessions.length + 1}`;
            const created: Session = {
              id,
              customer: params.customer,
              status: "open",
              url: `https://checkout.test/${id}`,
              created: s.clock,
              expires_at: s.clock + 24 * 3600,
              metadata: params.metadata,
            };
            s.sessions.push(created);
            return created;
          });
          s.onCreate?.();
          await respond("sessions.create");
          return { ...session };
        },
      },
    };
    billingPortal = {
      sessions: {
        create: async ({ customer }: { customer: string }) => {
          s.calls.portal++;
          await respond("portal.create");
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
vi.mock("@/server/integrations/redis", () => {
  const live = (key: string) => {
    const lock = s.locks.get(key);
    if (lock && lock.expiresAt <= Date.now()) s.locks.delete(key);
    return s.locks.get(key);
  };
  return {
    redis: {
      set: async (key: string, value: string, opts: { nx: boolean; px: number }) => {
        if (s.redisDown) throw new Error("redis timeout");
        if (s.lockAlwaysFree) return "OK";
        if (opts.nx && live(key)) return null;
        s.locks.set(key, { value, expiresAt: Date.now() + opts.px });
        return "OK";
      },
      eval: async (script: string, keys: string[], args: string[]) => {
        if (script.includes("pexpire")) {
          if (s.redisDown || s.redisDownOnRenew) throw new Error("redis timeout");
          if (s.lockAlwaysFree) return 1;
          const lock = live(keys[0]!);
          if (!lock || lock.value !== args[0]) return 0;
          lock.expiresAt = Date.now() + Number(args[1]);
          return 1;
        }
        if (live(keys[0]!)?.value === args[0]) s.locks.delete(keys[0]!);
        return 1;
      },
    },
  };
});
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
        await sleep(0);
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
        if (org && s.storeRace) org.stripeCustomerId = s.storeRace;
        if (!org || org.stripeCustomerId !== null) return { count: 0 };
        org.stripeCustomerId = data.stripeCustomerId;
        return { count: 1 };
      },
    },
  },
}));

import { openBillingPortal, startPlanChange } from "@/server/services/billing/plan-change";
import { actionRateLimitError } from "@/server/security/rate-limit";
import {
  STRIPE_BILLING_CALL_HARD_LIMIT_MS,
  STRIPE_BILLING_CALL_TIMEOUT_MS,
} from "@/server/integrations/stripe";

const ctxA = { orgId: "org-a", userId: "user-a", email: "owner@a.test", locale: "en" };
const ctxB = { orgId: "org-b", userId: "user-b", email: "owner@b.test", locale: "fi" };
const OLD_CLAIM_MS = 30_000;

function openSessions(customer?: string) {
  return s.sessions.filter((x) => x.status === "open" && (!customer || x.customer === customer));
}
function urlsOf(results: Array<{ kind: string; url?: string }>) {
  return results.filter((r) => r.kind === "checkout").map((r) => r.url!);
}
/** Handed-out Checkout URLs whose session is still open: at most one may be. */
function usable(results: Array<{ kind: string; url?: string }>) {
  const open = new Set(openSessions().map((x) => x.url));
  return [...new Set(urlsOf(results))].filter((u) => open.has(u));
}
function openSession(over: Partial<Session> & { id: string; customer: string }): Session {
  return {
    status: "open",
    url: `https://checkout.test/${over.id}`,
    created: s.clock - 60,
    expires_at: s.clock + 23 * 3600,
    metadata: {},
    ...over,
  };
}

let warn: ReturnType<typeof vi.spyOn>;
function events() {
  return warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

beforeEach(() => {
  s.orgs = new Map([
    ["org-a", { name: "A", stripeCustomerId: null, subscription: null, members: 2 }],
    ["org-b", { name: "B", stripeCustomerId: "cus_b", subscription: null, members: 1 }],
  ]);
  s.customers = [];
  s.idempotency = new Map();
  s.stripeSubs = new Map();
  s.invoices = new Map();
  s.sessions = [];
  s.locks = new Map();
  s.redisDown = false;
  s.redisDownOnRenew = false;
  s.lockAlwaysFree = false;
  s.limited = null;
  s.delay = {};
  s.expireRefused = new Map();
  s.storeRace = null;
  s.onCreate = null;
  s.calls = { customersCreate: 0, sessionsCreate: 0, portal: 0 };
  s.createOptions = [];
  s.clock = Math.floor(Date.now() / 1000);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
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
      priceId: "price_pro_m",
      seats: "2",
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
    s.stripeSubs.set("cus_a", [
      { id: "sub_1", status: "canceled" },
      { id: "sub_2", status: "incomplete_expired" },
    ]);
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });
});

describe("reuse distinguishes price and seats", () => {
  beforeEach(() => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
  });
  const meta = (over: Record<string, string> = {}) => ({
    orgId: "org-a",
    plan: "PRO",
    interval: "monthly",
    priceId: "price_pro_m",
    seats: "2",
    ...over,
  });

  it("an open Checkout for the same price and seat count is reused", async () => {
    s.sessions.push(openSession({ id: "cs_old", customer: "cus_a", metadata: meta() }));
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "checkout",
      url: "https://checkout.test/cs_old",
    });
    expect(s.calls.sessionsCreate).toBe(0);
  });

  it.each([
    ["a different seat count (a member joined since)", meta({ seats: "1" })],
    ["a different price for the same plan name", meta({ priceId: "price_pro_old" })],
    [
      "no price or seats recorded (created before this change)",
      { orgId: "org-a", plan: "PRO", interval: "monthly" },
    ],
    ["another organization's metadata on this customer", meta({ orgId: "org-b" })],
  ])("%s → expired and replaced, never handed out", async (_label, metadata) => {
    s.sessions.push(openSession({ id: "cs_old", customer: "cus_a", metadata }));
    const result = await startPlanChange(ctxA, "PRO", "monthly");
    expect(result).toEqual({ kind: "checkout", url: "https://checkout.test/cs_2" });
    expect(s.sessions.find((x) => x.id === "cs_old")!.status).toBe("expired");
    expect(openSessions()).toHaveLength(1);
  });

  it("a matching Checkout about to expire isn't handed out again", async () => {
    s.sessions.push(
      openSession({ id: "cs_old", customer: "cus_a", metadata: meta(), expires_at: s.clock + 60 }),
    );
    const result = await startPlanChange(ctxA, "PRO", "monthly");
    expect(result).toEqual({ kind: "checkout", url: "https://checkout.test/cs_2" });
    expect(s.sessions.find((x) => x.id === "cs_old")!.status).toBe("expired");
  });
});

describe("an organization with a subscription goes to the Billing Portal", () => {
  it.each(["ACTIVE", "TRIALING", "PAST_DUE", "PAUSED"])(
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

  it.each(["active", "trialing", "past_due", "unpaid", "paused"])(
    "Stripe reports %s before our webhook has stored it → portal, no Checkout",
    async (status) => {
      s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
      s.stripeSubs.set("cus_a", [{ id: "sub_1", status }]);
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

describe("a subscription waiting for its first payment (INCOMPLETE)", () => {
  beforeEach(() => {
    Object.assign(s.orgs.get("org-a")!, {
      stripeCustomerId: "cus_a",
      subscription: { stripeSubscriptionId: "sub_1", status: "INCOMPLETE" },
    });
  });

  it("stored INCOMPLETE with an open first invoice → that invoice's payment page, no Checkout", async () => {
    s.invoices.set("sub_1", { status: "open", hosted_invoice_url: "https://invoice.test/in_1" });
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "payment",
      url: "https://invoice.test/in_1",
    });
    expect(s.calls).toEqual({ customersCreate: 0, sessionsCreate: 0, portal: 0 });
  });

  it("no open invoice to pay → the Billing Portal, still no Checkout", async () => {
    s.invoices.set("sub_1", { status: "void", hosted_invoice_url: "https://invoice.test/in_1" });
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "portal",
      url: "https://portal.test/cus_a",
    });
    expect(s.calls.sessionsCreate).toBe(0);
  });

  it("Stripe reports incomplete before our webhook stored anything → payment page", async () => {
    s.orgs.get("org-a")!.subscription = null;
    s.stripeSubs.set("cus_a", [{ id: "sub_9", status: "incomplete" }]);
    s.invoices.set("sub_9", { status: "open", hosted_invoice_url: "https://invoice.test/in_9" });
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "payment",
      url: "https://invoice.test/in_9",
    });
  });

  it("an active subscription next to an incomplete one wins: portal, not the payment page", async () => {
    s.orgs.get("org-a")!.subscription = null;
    s.stripeSubs.set("cus_a", [
      { id: "sub_9", status: "incomplete" },
      { id: "sub_1", status: "active" },
    ]);
    s.invoices.set("sub_9", { status: "open", hosted_invoice_url: "https://invoice.test/in_9" });
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("portal");
  });

  it("the portal button sends an INCOMPLETE org to its payment page too", async () => {
    s.invoices.set("sub_1", { status: "open", hosted_invoice_url: "https://invoice.test/in_1" });
    expect(await openBillingPortal(ctxA)).toEqual({
      kind: "payment",
      url: "https://invoice.test/in_1",
    });
  });
});

describe("Stripe calls are bounded", () => {
  it("every Checkout creation has a timeout, no automatic retry, and an idempotency key", async () => {
    await startPlanChange(ctxA, "PRO", "monthly");
    expect(s.createOptions).toEqual([
      {
        timeout: STRIPE_BILLING_CALL_TIMEOUT_MS,
        maxNetworkRetries: 0,
        idempotencyKey: expect.stringMatching(/^checkout:org-a:[0-9a-f-]{36}$/),
      },
    ]);
    expect(STRIPE_BILLING_CALL_HARD_LIMIT_MS).toBeLessThan(OLD_CLAIM_MS / 2);
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

  it("several slow Stripe calls, together longer than the old 30 s claim: a second tab entering after 31 s is still busy", async () => {
    vi.useFakeTimers();
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    // Each call stays under the per-call bound; together they take 36 s.
    s.delay = {
      "subscriptions.list": 9_000,
      "sessions.list": 9_000,
      "sessions.create": 9_000,
    };
    const first = startPlanChange(ctxA, "PRO", "monthly");
    await vi.advanceTimersByTimeAsync(OLD_CLAIM_MS + 1_000);
    const second = startPlanChange(ctxA, "PRO", "monthly");
    await vi.advanceTimersByTimeAsync(60_000);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual({ kind: "checkout", url: "https://checkout.test/cs_1" });
    expect(results[1]).toEqual({ kind: "refused", reason: "busy" });
    expect(s.calls.sessionsCreate).toBe(1);
    expect(usable(results)).toEqual(["https://checkout.test/cs_1"]);
  });

  it("a Checkout creation that never answers is abandoned at the bound, its URL never handed out, and the next tab ends with one usable Checkout", async () => {
    vi.useFakeTimers();
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    s.delay = { "sessions.create": 120_000 }; // far longer than the old 30 s claim
    const first = startPlanChange(ctxA, "PRO", "annual");
    await vi.advanceTimersByTimeAsync(STRIPE_BILLING_CALL_HARD_LIMIT_MS + 1_000);
    expect(await first).toEqual({ kind: "refused", reason: "unavailable" });
    expect(events()).toContainEqual({
      event: "billing_stripe_timeout",
      orgId: "org-a",
      step: "plan_change",
    });
    // Stripe did create cs_1, but nobody received its URL. The next tab,
    // after the old claim would have expired, for another plan:
    s.delay = {};
    await vi.advanceTimersByTimeAsync(OLD_CLAIM_MS);
    const pending = startPlanChange(ctxA, "STARTER", "monthly");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await pending;
    expect(second).toEqual({ kind: "checkout", url: "https://checkout.test/cs_2" });
    expect(openSessions().map((x) => x.id)).toEqual(["cs_2"]);
    expect(usable([await first, second])).toEqual(["https://checkout.test/cs_2"]);
  });

  it("many slow expirations of old Checkouts, longer than the old 30 s claim: a second tab is still busy", async () => {
    vi.useFakeTimers();
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    for (const id of ["cs_o1", "cs_o2", "cs_o3", "cs_o4"]) {
      s.sessions.push(openSession({ id, customer: "cus_a", metadata: { plan: "STARTER" } }));
    }
    s.delay = { "sessions.expire": 9_000 };
    const first = startPlanChange(ctxA, "PRO", "monthly");
    await vi.advanceTimersByTimeAsync(OLD_CLAIM_MS + 1_000);
    const second = startPlanChange(ctxA, "PRO", "monthly");
    await vi.advanceTimersByTimeAsync(60_000);
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual({ kind: "refused", reason: "busy" });
    expect(results[0]!.kind).toBe("checkout");
    expect(s.calls.sessionsCreate).toBe(1);
    expect(usable(results)).toHaveLength(1);
  });

  it("the claim is confirmed still ours immediately before the Checkout is created", async () => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    s.delay = { "sessions.list": 5 };
    const attempt = startPlanChange(ctxA, "PRO", "monthly");
    await sleep(1);
    // Another request took the claim (e.g. ours expired during a Redis failover).
    s.locks.set("billing:plan-change:org-a", {
      value: "someone-else",
      expiresAt: Date.now() + 30_000,
    });
    expect(await attempt).toEqual({ kind: "refused", reason: "busy" });
    expect(s.calls.sessionsCreate).toBe(0);
    expect(s.locks.get("billing:plan-change:org-a")?.value).toBe("someone-else");
  });

  it("Redis failing during the section stops it before any Checkout, never runs unguarded", async () => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    s.redisDownOnRenew = true;
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "refused",
      reason: "unavailable",
    });
    expect(s.calls.sessionsCreate).toBe(0);
  });

  it("two attempts overlapping without any claim, same plan: both get the same single Checkout", async () => {
    s.lockAlwaysFree = true;
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    const results = await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "PRO", "monthly"),
    ]);
    expect(openSessions()).toHaveLength(1);
    expect(new Set(urlsOf(results))).toEqual(new Set([openSessions()[0]!.url]));
  });

  it("two attempts overlapping without any claim, different plans: only one usable Checkout survives", async () => {
    s.lockAlwaysFree = true;
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    const results = await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "STARTER", "annual"),
    ]);
    expect(openSessions()).toHaveLength(1);
    expect(usable(results)).toHaveLength(1);
    expect(results.filter((r) => r.kind === "refused")).toHaveLength(1);
  });

  it("a newer Checkout from an overlapping attempt never expires an older URL already handed out", async () => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    const first = await startPlanChange(ctxA, "PRO", "monthly");
    // An overlapping attempt (claim lost) whose pre-create look missed cs_1:
    // its own session is newer, so it yields to cs_1.
    s.lockAlwaysFree = true;
    s.clock += 1;
    s.sessions.push(
      openSession({
        id: "cs_9",
        customer: "cus_a",
        created: s.clock,
        metadata: {
          orgId: "org-a",
          plan: "PRO",
          interval: "monthly",
          priceId: "price_pro_m",
          seats: "2",
        },
      }),
    );
    const second = await startPlanChange(ctxA, "PRO", "monthly");
    expect(first).toEqual({ kind: "checkout", url: "https://checkout.test/cs_1" });
    expect(second).toEqual(first);
    expect(openSessions().map((x) => x.id)).toEqual(["cs_1"]);
  });
});

describe("the Stripe customer", () => {
  it("even if two attempts overlap anyway, exactly one Stripe customer results", async () => {
    s.lockAlwaysFree = true;
    await Promise.all([
      startPlanChange(ctxA, "PRO", "monthly"),
      startPlanChange(ctxA, "PRO", "monthly"),
    ]);
    expect(s.customers).toHaveLength(1);
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_1");
  });

  it("losing the customer race: the stored customer is used, never overwritten, and the orphan is logged without personal data", async () => {
    s.storeRace = "cus_winner";
    const result = await startPlanChange(ctxA, "PRO", "monthly");
    expect(result.kind).toBe("checkout");
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_winner");
    expect(new Set(s.sessions.map((x) => x.customer))).toEqual(new Set(["cus_winner"]));
    expect(events()).toContainEqual({
      event: "billing_orphan_stripe_customer",
      orgId: "org-a",
      orphanCustomerId: "cus_1",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("owner@a.test");
    expect(logged).not.toContain('"A"');
  });

  it("a replayed customer creation (same key) returns the same customer", async () => {
    s.idempotency.set("org-customer:org-a", { id: "cus_earlier" });
    await startPlanChange(ctxA, "PRO", "monthly");
    expect(s.calls.customersCreate).toBe(0);
    expect(s.orgs.get("org-a")!.stripeCustomerId).toBe("cus_earlier");
    expect(events()).toEqual([]);
  });

  it("customer creation uses one key per organization; Checkout creation one key per attempt", async () => {
    await startPlanChange(ctxA, "PRO", "monthly");
    const keys = [...s.idempotency.keys()];
    expect(keys).toContain("org-customer:org-a");
    expect(keys.filter((k) => /^checkout:org-a:[0-9a-f-]{36}$/.test(k))).toHaveLength(1);
  });
});

describe("Checkout expiration failures are handled deliberately", () => {
  beforeEach(() => {
    s.orgs.get("org-a")!.stripeCustomerId = "cus_a";
    s.sessions.push(
      openSession({
        id: "cs_old",
        customer: "cus_a",
        metadata: { orgId: "org-a", plan: "STARTER" },
      }),
    );
  });

  it("Stripe won't expire an old Checkout that is still open → no new Checkout, unavailable, logged", async () => {
    s.expireRefused.set("cs_old", "open");
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "refused",
      reason: "unavailable",
    });
    expect(s.calls.sessionsCreate).toBe(0);
    expect(events()).toContainEqual({
      event: "billing_checkout_expire_failed",
      orgId: "org-a",
      sessionId: "cs_old",
      outcome: "failed",
    });
  });

  it("the old Checkout was paid in the meantime → no new Checkout, busy", async () => {
    s.expireRefused.set("cs_old", "complete");
    expect(await startPlanChange(ctxA, "PRO", "monthly")).toEqual({
      kind: "refused",
      reason: "busy",
    });
    expect(s.calls.sessionsCreate).toBe(0);
  });

  it("the old Checkout had already expired on its own → that's fine, a new one is created", async () => {
    s.sessions[0]!.status = "expired";
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });

  it("after creating, a newer overlapping Checkout that can't be expired → ours is expired too and not handed out", async () => {
    s.sessions = [];
    s.lockAlwaysFree = true;
    // Appears while ours is being created: an overlapping attempt's, newer.
    s.onCreate = () => {
      s.onCreate = null;
      s.sessions.push(openSession({ id: "cs_x", customer: "cus_a", created: s.clock + 1 }));
      s.expireRefused.set("cs_x", "open");
    };
    const attempt = startPlanChange(ctxA, "PRO", "monthly");
    expect(await attempt).toEqual({ kind: "refused", reason: "unavailable" });
    expect(openSessions().map((x) => x.id)).toEqual(["cs_x"]);
    expect(s.sessions.find((x) => x.id !== "cs_x")!.status).toBe("expired");
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

describe("openBillingPortal", () => {
  beforeEach(() => {
    Object.assign(s.orgs.get("org-a")!, {
      stripeCustomerId: "cus_a",
      subscription: { stripeSubscriptionId: "sub_1", status: "ACTIVE" },
    });
  });

  it("opens the portal for the org's own customer, under its own rate limits", async () => {
    expect(await openBillingPortal(ctxA)).toEqual({
      kind: "portal",
      url: "https://portal.test/cus_a",
    });
    expect(vi.mocked(actionRateLimitError)).toHaveBeenLastCalledWith(
      ["auth", "billing-portal:org:org-a"],
      ["auth", "billing-portal:user:user-a"],
    );
  });

  it.each([
    ["rate_limited", "busy"],
    ["service_unavailable", "unavailable"],
  ] as const)("rate limit %s → refused %s, no portal session", async (limited, reason) => {
    s.limited = limited;
    expect(await openBillingPortal(ctxA)).toEqual({ kind: "refused", reason });
    expect(s.calls.portal).toBe(0);
  });

  it("no Stripe customer yet → nothing to open", async () => {
    s.orgs.get("org-a")!.stripeCustomerId = null;
    expect(await openBillingPortal(ctxA)).toBeNull();
    expect(s.calls.portal).toBe(0);
  });

  it("a portal call that never answers → unavailable at the bound", async () => {
    vi.useFakeTimers();
    s.delay = { "portal.create": 120_000 };
    const result = openBillingPortal(ctxA);
    await vi.advanceTimersByTimeAsync(STRIPE_BILLING_CALL_HARD_LIMIT_MS + 1_000);
    expect(await result).toEqual({ kind: "refused", reason: "unavailable" });
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
    s.stripeSubs.set("cus_b", [{ id: "sub_b", status: "active" }]);
    expect((await startPlanChange(ctxA, "PRO", "monthly")).kind).toBe("checkout");
  });
});
