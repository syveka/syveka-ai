import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI messages are one pooled monthly allowance per organization: the count
 * is the organization's, compared with aiMessagesPerOrgMonth, never
 * multiplied by members or seats. Only Redis and the database are faked.
 */
const { cache, subscription } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  subscription: { current: null as null | { plan: string; status: string; seats: number } },
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
      findUnique: vi.fn(async () =>
        subscription.current ? { ...subscription.current, updatedAt: new Date() } : null,
      ),
    },
    entitlementGrant: { findMany: vi.fn(async () => []) },
  },
}));

import {
  assertWithinLimit,
  EntitlementError,
  entitlementsCacheKey,
  getEntitlements,
} from "@/server/services/billing/entitlements";

const ORG = "11111111-1111-4111-8111-111111111111";

function onPlan(plan: string, seats: number) {
  subscription.current = { plan, status: "ACTIVE", seats };
}

describe("pooled organization AI allowance", () => {
  beforeEach(() => {
    cache.clear();
    subscription.current = null;
  });

  it("FREE: the organization shares 50 messages a month (the advertised number)", async () => {
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 49 }),
    ).resolves.toBeDefined();
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 50 }),
    ).rejects.toBeInstanceOf(EntitlementError);
  });

  it("STARTER: 1,000 for the whole organization, not 1,000 per seat", async () => {
    onPlan("STARTER", 10);
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 999 }),
    ).resolves.toBeDefined();
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 1_000 }),
    ).rejects.toBeInstanceOf(EntitlementError);
  });

  it("PRO: 5,000 for the whole organization regardless of seats", async () => {
    onPlan("PRO", 50);
    const ent = await getEntitlements(ORG);
    expect(ent.aiMessagesPerOrgMonth).toBe(5_000);
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 5_000 }),
    ).rejects.toBeInstanceOf(EntitlementError);
  });

  it("names the pooled limit in the error", async () => {
    const error = await assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 50 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EntitlementError);
    expect((error as EntitlementError).code).toBe("entitlement_exceeded");
    expect((error as EntitlementError).limit).toBe("aiMessagesPerOrgMonth");
  });

  it("ignores an entitlements object cached under the pre-rename key", async () => {
    // Shape cached before this change: no aiMessagesPerOrgMonth. Read as-is,
    // its missing limit would compare as never reached (unlimited messages).
    cache.set(`ent:${ORG}`, { plan: "FREE", aiMessagesPerUserMonth: 25, seats: 1 });

    expect(entitlementsCacheKey(ORG)).not.toBe(`ent:${ORG}`);
    const ent = await getEntitlements(ORG);
    expect(ent.aiMessagesPerOrgMonth).toBe(50);
    await expect(
      assertWithinLimit(ORG, { kind: "ai_messages", orgMonthCount: 50 }),
    ).rejects.toBeInstanceOf(EntitlementError);
  });
});
