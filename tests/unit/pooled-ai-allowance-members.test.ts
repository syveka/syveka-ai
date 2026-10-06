import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI allowance is one pool per organization, shared by its members. This
 * drives the same calls the chat route makes -- recordUsage() per member's
 * message, then getMonthUsage() + assertWithinLimit() -- against an in-memory
 * usage table that applies the real organization/metric/month filter. Only
 * Redis and the database are faked.
 */
const { cache, subscriptions, usageRows } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  subscriptions: new Map<string, { plan: string; status: string; seats: number }>(),
  usageRows: [] as Array<{
    organizationId: string;
    metric: string;
    quantity: number;
    periodStart: Date;
    metadata: unknown;
  }>,
}));

vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      cache.delete(key);
    }),
  },
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    subscription: {
      findUnique: vi.fn(async ({ where }: { where: { organizationId: string } }) => {
        const sub = subscriptions.get(where.organizationId);
        return sub ? { ...sub, updatedAt: new Date() } : null;
      }),
    },
    entitlementGrant: { findMany: vi.fn(async () => []) },
    usageRecord: {
      create: vi.fn(async ({ data }: { data: (typeof usageRows)[number] }) => {
        usageRows.push(data);
        return data;
      }),
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; metric: string; periodStart: { gte: Date } };
        }) => {
          const quantity = usageRows
            .filter(
              (row) =>
                row.organizationId === where.organizationId &&
                row.metric === where.metric &&
                row.periodStart >= where.periodStart.gte,
            )
            .reduce((sum, row) => sum + row.quantity, 0);
          return { _sum: { quantity: quantity || null } };
        },
      ),
    },
  },
}));

import {
  assertWithinLimit,
  EntitlementError,
  getEntitlements,
  getMonthUsage,
  invalidateEntitlements,
  recordUsage,
} from "@/server/services/billing/entitlements";

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";

/** One chat message by `userId`, recorded exactly as the chat route records it. */
async function sendMessages(orgId: string, userId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await recordUsage(orgId, "AI_MESSAGES", 1, { userId });
  }
}

/** The chat route's quota check: the organization's month total against its allowance. */
async function checkQuota(orgId: string) {
  const orgMonthCount = await getMonthUsage(orgId, "AI_MESSAGES");
  return assertWithinLimit(orgId, { kind: "ai_messages", orgMonthCount });
}

async function onPlan(orgId: string, plan: string, seats: number) {
  subscriptions.set(orgId, { plan, status: "ACTIVE", seats });
  await invalidateEntitlements(orgId);
}

describe("members share one organization AI allowance", () => {
  beforeEach(() => {
    cache.clear();
    subscriptions.clear();
    usageRows.length = 0;
  });

  it("FREE: two members' messages add up, and the organization stops at 50", async () => {
    await sendMessages(ORG, "member-a", 25);
    await sendMessages(ORG, "member-b", 24);

    expect(await getMonthUsage(ORG, "AI_MESSAGES")).toBe(49);
    await expect(checkQuota(ORG)).resolves.toBeDefined();

    await sendMessages(ORG, "member-b", 1);

    expect(await getMonthUsage(ORG, "AI_MESSAGES")).toBe(50);
    const error = await checkQuota(ORG).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntitlementError);
    expect((error as EntitlementError).limit).toBe("aiMessagesPerOrgMonth");
    // The pool is exhausted for every member: member-a has sent only 25, but
    // there is no per-member allowance to fall back on.
    const sentByA = usageRows.filter(
      (row) => (row.metadata as { userId: string }).userId === "member-a",
    ).length;
    expect(sentByA).toBe(25);
  });

  it("adding seats and members does not multiply the allowance", async () => {
    await onPlan(ORG, "STARTER", 2);
    const twoSeats = (await getEntitlements(ORG)).aiMessagesPerOrgMonth;
    await onPlan(ORG, "STARTER", 10);
    const tenSeats = (await getEntitlements(ORG)).aiMessagesPerOrgMonth;
    expect(twoSeats).toBe(1_000);
    expect(tenSeats).toBe(1_000);

    // Ten members at 100 messages each use up the one 1,000-message pool.
    for (let member = 0; member < 10; member++) {
      await sendMessages(ORG, `member-${member}`, member === 9 ? 99 : 100);
    }
    expect(await getMonthUsage(ORG, "AI_MESSAGES")).toBe(999);
    await expect(checkQuota(ORG)).resolves.toBeDefined();

    await sendMessages(ORG, "member-9", 1);
    await expect(checkQuota(ORG)).rejects.toBeInstanceOf(EntitlementError);
  });

  it("another organization's usage never counts against this pool", async () => {
    await sendMessages(OTHER_ORG, "someone-else", 50);
    await sendMessages(ORG, "member-a", 10);

    expect(await getMonthUsage(ORG, "AI_MESSAGES")).toBe(10);
    await expect(checkQuota(ORG)).resolves.toBeDefined();
    await expect(checkQuota(OTHER_ORG)).rejects.toBeInstanceOf(EntitlementError);
  });
});
