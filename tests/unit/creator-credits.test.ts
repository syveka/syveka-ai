import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, unscopedPrismaMock, getEntitlementsMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  unscopedPrismaMock: {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(unscopedPrismaMock)),
    creatorCreditGrant: { create: vi.fn(async () => ({})) },
    creatorCreditBalance: {
      upsert: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(
        async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
          count: 1,
        }),
      ),
    },
    creatorCreditTransaction: {
      create: vi.fn(async () => ({})),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
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
  creatorGenerationCreditsSettled,
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
    const result = await commitCreatorCredits(ctx(), {
      generationId: "gen-1",
      reservedAmount: 10,
      actualAmount: 6,
    });

    expect(result).toEqual({ applied: true });
    const args = unscopedPrismaMock.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data.reservedCredits).toEqual({ decrement: 10 });
    expect(args.data.availableCredits).toEqual({ increment: 4 });
    // Ledger insert and balance mutation happen inside the same transaction.
    expect(unscopedPrismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(unscopedPrismaMock.creatorCreditTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "COMMIT" }) }),
    );
  });

  it("commit: does not touch availableCredits when the full reservation was consumed", async () => {
    await commitCreatorCredits(ctx(), {
      generationId: "gen-1",
      reservedAmount: 10,
      actualAmount: 10,
    });

    const args = unscopedPrismaMock.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data.availableCredits).toBeUndefined();
  });

  it("commit: is idempotent — a duplicate COMMIT for the same generation is a no-op, not a double-apply", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    Object.setPrototypeOf(p2002, Prisma.PrismaClientKnownRequestError.prototype);
    unscopedPrismaMock.$transaction.mockRejectedValueOnce(p2002);

    const result = await commitCreatorCredits(ctx(), {
      generationId: "gen-1",
      reservedAmount: 10,
      actualAmount: 10,
    });

    expect(result).toEqual({ applied: false });
  });

  it("commit: a genuine DB error (not a unique-constraint no-op) still propagates", async () => {
    unscopedPrismaMock.$transaction.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      commitCreatorCredits(ctx(), { generationId: "gen-1", reservedAmount: 10, actualAmount: 10 }),
    ).rejects.toThrow("connection reset");
  });

  it("release: fully refunds the reservation back to available on failure", async () => {
    const result = await releaseCreatorCredits(ctx(), {
      generationId: "gen-1",
      amount: 10,
      reason: "generation_failed",
    });

    expect(result).toEqual({ applied: true });
    const args = unscopedPrismaMock.creatorCreditBalance.updateMany.mock.calls[0]![0];
    expect(args.data).toMatchObject({
      reservedCredits: { decrement: 10 },
      availableCredits: { increment: 10 },
    });
  });

  it("release: is idempotent — a duplicate RELEASE for the same generation is a no-op", async () => {
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    Object.setPrototypeOf(p2002, Prisma.PrismaClientKnownRequestError.prototype);
    unscopedPrismaMock.$transaction.mockRejectedValueOnce(p2002);

    const result = await releaseCreatorCredits(ctx(), {
      generationId: "gen-1",
      amount: 10,
      reason: "generation_failed",
    });

    expect(result).toEqual({ applied: false });
  });

  it("creatorGenerationCreditsSettled: reflects whether a COMMIT or RELEASE already exists for a generation", async () => {
    unscopedPrismaMock.creatorCreditTransaction.findFirst.mockResolvedValueOnce(null);
    expect(await creatorGenerationCreditsSettled("gen-1")).toBe(false);

    unscopedPrismaMock.creatorCreditTransaction.findFirst.mockResolvedValueOnce({ id: "txn-1" });
    expect(await creatorGenerationCreditsSettled("gen-1")).toBe(true);
  });

  it("scopes every ledger mutation to the caller's organization (tenant isolation)", async () => {
    await reserveCreatorCredits(ctx("org-b"), { generationId: "gen-1", amount: 5 });
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
  });
});
