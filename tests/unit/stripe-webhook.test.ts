import { beforeEach, describe, expect, it, vi } from "vitest";

class FakePrismaKnownError extends Error {
  code: string;
  constructor(code: string) {
    super(`Prisma error ${code}`);
    this.code = code;
  }
}

type LedgerWriteArgs = { where?: unknown; data?: { status?: string; [key: string]: unknown } };

const mocks = vi.hoisted(() => {
  const txSubscriptionUpsert = vi.fn(async (_args: unknown) => ({}));
  const txSubscriptionUpdate = vi.fn(async (_args: unknown) => ({}));
  const txStripeWebhookEventUpdate = vi.fn(async (_args: LedgerWriteArgs) => ({}));
  const tx = {
    subscription: { upsert: txSubscriptionUpsert, update: txSubscriptionUpdate },
    stripeWebhookEvent: { update: txStripeWebhookEventUpdate },
  };
  return {
    tx,
    txSubscriptionUpsert,
    txSubscriptionUpdate,
    txStripeWebhookEventUpdate,
    ledgerCreate: vi.fn(async (_args: unknown) => ({})),
    ledgerFindUnique: vi.fn(async (_args: unknown) => null as Record<string, unknown> | null),
    ledgerUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
    ledgerUpdate: vi.fn(async (_args: LedgerWriteArgs) => ({})),
    organizationFindUnique: vi.fn(async (_args: unknown) => null as { id: string } | null),
    transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx)),
    constructEvent: vi.fn(),
    subscriptionsRetrieve: vi.fn(),
    subscriptionsUpdate: vi.fn(async () => ({})),
    planForPriceId: vi.fn(() => "PRO" as string | null),
    invalidateEntitlements: vi.fn(async () => undefined),
    getStripeEnv: vi.fn(() => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" })),
  };
});

vi.mock("@/env", () => ({ getStripeEnv: mocks.getStripeEnv }));

vi.mock("@/server/integrations/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: mocks.constructEvent },
    subscriptions: { retrieve: mocks.subscriptionsRetrieve, update: mocks.subscriptionsUpdate },
  },
  planForPriceId: mocks.planForPriceId,
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    stripeWebhookEvent: {
      create: mocks.ledgerCreate,
      findUnique: mocks.ledgerFindUnique,
      updateMany: mocks.ledgerUpdateMany,
      update: mocks.ledgerUpdate,
    },
    organization: { findUnique: mocks.organizationFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  invalidateEntitlements: mocks.invalidateEntitlements,
}));

import { POST } from "@/app/api/v1/webhooks/stripe/route";

function webhookRequest(body: string, signature: string | null = "t=1,v1=fake"): Request {
  const headers = new Headers();
  if (signature) headers.set("stripe-signature", signature);
  return new Request("https://example.test/api/v1/webhooks/stripe", {
    method: "POST",
    body,
    headers,
  });
}

function fakeSubscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "sub_123",
    status: "active",
    metadata: { orgId: "org-a" },
    items: { data: [{ price: { id: "price_pro_monthly" }, quantity: 1 }] },
    current_period_end: 1_700_000_000,
    cancel_at_period_end: false,
    trial_end: null,
    ...overrides,
  };
}

function fakeEvent(type: string, object: Record<string, unknown>, id = "evt_123") {
  return { id, type, data: { object } };
}

// `resetAllMocks` (not `clearAllMocks`) so a return value set by one test can
// never leak into the next -- every default this suite relies on is
// re-established here, explicitly, on every run.
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (cb: (tx: typeof mocks.tx) => Promise<unknown>) =>
    cb(mocks.tx),
  );
  mocks.txSubscriptionUpsert.mockResolvedValue({});
  mocks.txSubscriptionUpdate.mockResolvedValue({});
  mocks.txStripeWebhookEventUpdate.mockResolvedValue({});
  mocks.ledgerCreate.mockResolvedValue({});
  mocks.ledgerFindUnique.mockResolvedValue(null);
  mocks.ledgerUpdateMany.mockResolvedValue({ count: 1 });
  mocks.ledgerUpdate.mockResolvedValue({});
  mocks.organizationFindUnique.mockResolvedValue(null);
  mocks.subscriptionsUpdate.mockResolvedValue({});
  mocks.planForPriceId.mockReturnValue("PRO");
  mocks.invalidateEntitlements.mockResolvedValue(undefined);
  mocks.getStripeEnv.mockReturnValue({ STRIPE_WEBHOOK_SECRET: "whsec_test" });
});

describe("Stripe webhook signature verification", () => {
  it("rejects a request with no stripe-signature header without touching the ledger", async () => {
    const res = await POST(webhookRequest("{}", null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing signature" });
    expect(mocks.constructEvent).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("rejects a request whose signature fails verification, before any ledger write", async () => {
    mocks.constructEvent.mockImplementation(() => {
      throw new Error("no matching signature");
    });
    const res = await POST(webhookRequest("{}"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });
});

describe("first successful delivery", () => {
  it("processes a new event exactly once: claims, mutates, and completes atomically", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.ledgerCreate).toHaveBeenCalledWith({
      data: {
        stripeEventId: "evt_123",
        eventType: "customer.subscription.updated",
        organizationId: "org-a",
      },
    });
    expect(mocks.ledgerUpdateMany).toHaveBeenCalledWith({
      where: {
        stripeEventId: "evt_123",
        OR: [
          { status: { in: ["RECEIVED", "FAILED"] } },
          { status: "PROCESSING", lastAttemptAt: { lt: expect.any(Date) } },
        ],
      },
      data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: expect.any(Date) },
    });
    // Business mutation and ledger completion both happen inside the same transaction.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txSubscriptionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-a" },
        create: expect.objectContaining({ plan: "PRO", status: "ACTIVE", seats: 1 }),
        update: expect.objectContaining({ plan: "PRO", status: "ACTIVE", seats: 1 }),
      }),
    );
    expect(mocks.txStripeWebhookEventUpdate).toHaveBeenCalledWith({
      where: { stripeEventId: "evt_123" },
      data: expect.objectContaining({
        status: "COMPLETED",
        organizationId: "org-a",
        objectId: "sub_123",
      }),
    });
    expect(mocks.invalidateEntitlements).toHaveBeenCalledWith("org-a");
  });
});

describe("duplicate delivery after successful completion", () => {
  it("returns a safe duplicate response and never reprocesses", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);
    mocks.ledgerCreate.mockRejectedValue(new FakePrismaKnownError("P2002"));
    mocks.ledgerFindUnique.mockResolvedValue({ status: "COMPLETED" });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(mocks.ledgerUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txSubscriptionUpsert).not.toHaveBeenCalled();
  });
});

describe("failure before completion, then a successful Stripe retry", () => {
  it("marks FAILED (never COMPLETED) on the failing attempt, then lets the retry succeed", async () => {
    // First delivery: subscription is missing orgId metadata -> throws mid-processing.
    const badEvent = fakeEvent("customer.subscription.updated", fakeSubscription({ metadata: {} }));
    mocks.constructEvent.mockReturnValueOnce(badEvent);

    const firstAttempt = await POST(webhookRequest("{}"));
    expect(firstAttempt.status).toBe(500);
    expect(await firstAttempt.json()).toEqual({ error: "handler failed" });

    // The claim (PROCESSING) happened, but completion must never have been recorded.
    expect(mocks.ledgerUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.ledgerUpdate).toHaveBeenCalledWith({
      where: { stripeEventId: "evt_123" },
      data: { status: "FAILED", lastError: expect.stringContaining("missing orgId metadata") },
    });
    const allUpdateArgs = [
      ...mocks.ledgerUpdate.mock.calls.map((call) => call[0]),
      ...mocks.txStripeWebhookEventUpdate.mock.calls.map((call) => call[0]),
    ];
    const completedCalls = allUpdateArgs.filter((arg) => arg.data?.status === "COMPLETED");
    expect(completedCalls).toHaveLength(0);

    // Stripe retry: same event id, this time re-delivered with valid metadata.
    // The ledger row is now FAILED, so it is retriable.
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (cb: (tx: typeof mocks.tx) => Promise<unknown>) =>
      cb(mocks.tx),
    );
    mocks.planForPriceId.mockReturnValue("PRO");
    mocks.ledgerCreate.mockRejectedValue(new FakePrismaKnownError("P2002"));
    mocks.ledgerFindUnique.mockResolvedValue({ status: "FAILED", lastAttemptAt: new Date() });
    mocks.ledgerUpdateMany.mockResolvedValue({ count: 1 });
    const goodEvent = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValueOnce(goodEvent);

    const retry = await POST(webhookRequest("{}"));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true });
    expect(mocks.txStripeWebhookEventUpdate).toHaveBeenCalledWith({
      where: { stripeEventId: "evt_123" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });
});

describe("concurrent or near-concurrent duplicate deliveries", () => {
  it("returns a safe processing response when the ledger row is actively PROCESSING and not stale", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);
    mocks.ledgerCreate.mockRejectedValue(new FakePrismaKnownError("P2002"));
    mocks.ledgerFindUnique.mockResolvedValue({ status: "PROCESSING", lastAttemptAt: new Date() });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processing: true });
    expect(mocks.ledgerUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns a safe processing response when the atomic claim loses the race (count: 0)", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);
    mocks.ledgerFindUnique
      .mockResolvedValueOnce({ status: "RECEIVED" })
      .mockResolvedValueOnce({ status: "PROCESSING" });
    mocks.ledgerUpdateMany.mockResolvedValue({ count: 0 });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processing: true });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txSubscriptionUpsert).not.toHaveBeenCalled();
  });

  it("reclaims a stale PROCESSING row instead of skipping it forever", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);
    mocks.ledgerCreate.mockRejectedValue(new FakePrismaKnownError("P2002"));
    mocks.ledgerFindUnique.mockResolvedValue({
      status: "PROCESSING",
      lastAttemptAt: new Date(Date.now() - 10 * 60_000), // 10 minutes old
    });
    mocks.ledgerUpdateMany.mockResolvedValue({ count: 1 });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("unknown or unsupported event types", () => {
  it("acknowledges and marks complete without any business mutation", async () => {
    const event = fakeEvent("customer.created", { id: "cus_123" });
    mocks.constructEvent.mockReturnValue(event);

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.txSubscriptionUpsert).not.toHaveBeenCalled();
    expect(mocks.ledgerUpdate).toHaveBeenCalledWith({
      where: { stripeEventId: "evt_123" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });
});

describe("database/event-state failure behavior", () => {
  it("fails closed (retryable) when the ledger itself is unavailable on first write", async () => {
    const event = fakeEvent("customer.subscription.updated", fakeSubscription());
    mocks.constructEvent.mockReturnValue(event);
    mocks.ledgerCreate.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ledger unavailable" });
    expect(mocks.ledgerUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("existing subscription and entitlement behavior is unchanged", () => {
  it("customer.subscription.deleted downgrades to FREE and invalidates entitlements", async () => {
    const event = fakeEvent("customer.subscription.deleted", fakeSubscription({ id: "sub_del" }));
    mocks.constructEvent.mockReturnValue(event);

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(mocks.txSubscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: "org-a" },
      data: { plan: "FREE", status: "CANCELED", stripeSubscriptionId: null },
    });
    expect(mocks.invalidateEntitlements).toHaveBeenCalledWith("org-a");
  });

  it("invoice.payment_failed transitions the resolved organization's subscription to PAST_DUE", async () => {
    const event = fakeEvent("invoice.payment_failed", {
      id: "in_123",
      customer: "cus_123",
      subscription: "sub_123",
    });
    mocks.constructEvent.mockReturnValue(event);
    mocks.organizationFindUnique.mockResolvedValue({ id: "org-a" });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(mocks.txSubscriptionUpdate).toHaveBeenCalledWith({
      where: { organizationId: "org-a" },
      data: { status: "PAST_DUE" },
    });
    expect(mocks.invalidateEntitlements).toHaveBeenCalledWith("org-a");
  });

  it("invoice.paid retrieves the subscription and clears PAST_DUE via the same upsert path", async () => {
    const event = fakeEvent("invoice.paid", { id: "in_456", subscription: "sub_123" });
    mocks.constructEvent.mockReturnValue(event);
    mocks.subscriptionsRetrieve.mockResolvedValue(fakeSubscription({ status: "active" }));

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(200);
    expect(mocks.subscriptionsRetrieve).toHaveBeenCalledWith("sub_123");
    expect(mocks.txSubscriptionUpsert).toHaveBeenCalled();
    expect(mocks.invalidateEntitlements).toHaveBeenCalledWith("org-a");
  });
});
