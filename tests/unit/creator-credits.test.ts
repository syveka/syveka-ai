import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, unscopedPrismaMock, getEntitlementsMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  unscopedPrismaMock: {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(unscopedPrismaMock)),
    creatorCreditGrant: { create: vi.fn(async () => ({})) },
    creatorCreditBalance: { upsert: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) },
    creatorCreditTransaction: { create: vi.fn(async () => ({})) },
  },
  getEntitlementsMock: vi.fn(async () => ({ creatorCreditsPerMonth: 200 })),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: unscopedPrismaMock,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: getEntitlementsMock,
}));

import {
  getCreatorGenerationCreditCost,
  reserveCreatorCredits,
  commitCreatorCredits,
  releaseCreatorCredits,
  InsufficientCreditsError,
} from "@/server/services/creator-credits";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

describe("getCreatorGenerationCreditCost", () => {
  it("is deterministic and server-side only (no client input accepted)", () => {
    expect(getCreatorGenerationCreditCost("IMAGE", "mock", "default")).toBe(10);
    expect(getCreatorGenerationCreditCost("CAPTION", "anthropic", "default")).toBe(1);
  });

  it("scales image-to-video cost with duration", () => {
    const short = getCreatorGenerationCreditCost("IMAGE_TO_VIDEO", "mock", "default", {
      durationSeconds: 5,
    });
    const long = getCreatorGenerationCreditCost("IMAGE_TO_VIDEO", "mock", "default", {
      durationSeconds: 20,
    });
    expect(long).toBeGreaterThan(short);
  });

  it("applies a quality multiplier", () => {
    const standard = getCreatorGenerationCreditCost("IMAGE", "mock", "default", {
      quality: "standard",
    });
    const high = getCreatorGenerationCreditCost("IMAGE", "mock", "default", { quality: "high" });
    expect(high).toBeGreaterThan(standard);
  });

  it("never returns a non-positive cost", () => {
    expect(
      getCreatorGenerationCreditCost("CAPTION", "unknown-provider", "x"),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("credit reservation ledger", () => {
  let db: {
    creatorCreditBalance: { updateMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db = { creatorCreditBalance: { updateMany: vi.fn(async () => ({ count: 1 })) } };
    tenantDbMock.mockReturnValue(db);
    getEntitlementsMock.mockResolvedValue({ creatorCreditsPerMonth: 200 });
  });

  it("reserve: atomically conditions the UPDATE on availableCredits >= amount", async () => {
    await reserveCreatorCredits(ctx(), { generationId: "gen-1", amount: 10 });

    const args = db.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({ organizationId: "org-a", availableCredits: { gte: 10 } });
    expect(args.data).toMatchObject({
      availableCredits: { decrement: 10 },
      reservedCredits: { increment: 10 },
    });
  });

  it("reserve: throws InsufficientCreditsError when the conditional UPDATE matches zero rows", async () => {
    db.creatorCreditBalance.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      reserveCreatorCredits(ctx(), { generationId: "gen-1", amount: 999 }),
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it("reserve: never lets a second concurrent reservation double-spend the same balance", async () => {
    // Simulate two concurrent reservations against the same 15-credit balance,
    // each asking for 10: only the first conditional UPDATE can match.
    db.creatorCreditBalance.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await reserveCreatorCredits(ctx(), { generationId: "gen-1", amount: 10 });
    await expect(
      reserveCreatorCredits(ctx(), { generationId: "gen-2", amount: 10 }),
    ).rejects.toThrow(InsufficientCreditsError);
    expect(db.creatorCreditBalance.updateMany).toHaveBeenCalledTimes(2);
  });

  it("commit: refunds the unused portion of an over-reserved amount", async () => {
    await commitCreatorCredits(ctx(), {
      generationId: "gen-1",
      reservedAmount: 10,
      actualAmount: 6,
    });

    const args = db.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data.reservedCredits).toEqual({ decrement: 10 });
    expect(args.data.availableCredits).toEqual({ increment: 4 });
  });

  it("commit: does not touch availableCredits when the full reservation was consumed", async () => {
    await commitCreatorCredits(ctx(), {
      generationId: "gen-1",
      reservedAmount: 10,
      actualAmount: 10,
    });

    const args = db.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data.availableCredits).toBeUndefined();
  });

  it("release: fully refunds the reservation back to available on failure", async () => {
    await releaseCreatorCredits(ctx(), {
      generationId: "gen-1",
      amount: 10,
      reason: "generation_failed",
    });

    const args = db.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data).toMatchObject({
      reservedCredits: { decrement: 10 },
      availableCredits: { increment: 10 },
    });
  });

  it("scopes every ledger mutation to the caller's organization (tenant isolation)", async () => {
    await reserveCreatorCredits(ctx("org-b"), { generationId: "gen-1", amount: 5 });
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
  });
});
