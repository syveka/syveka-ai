import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async (): Promise<TenantContext> => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "MANAGER",
    locale: "en",
  })),
  createBusinessDnaService: vi.fn(async (_ctx: unknown, data: unknown) => ({
    id: "svc-1",
    ...(data as object),
  })),
  updateBusinessDnaService: vi.fn(async (_ctx: unknown, id: string, data: unknown) => ({
    id,
    ...(data as object),
  })),
  deactivateBusinessDnaService: vi.fn(async () => undefined),
  reactivateBusinessDnaService: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/business-dna-services", () => ({
  createBusinessDnaService: mocks.createBusinessDnaService,
  updateBusinessDnaService: mocks.updateBusinessDnaService,
  deactivateBusinessDnaService: mocks.deactivateBusinessDnaService,
  reactivateBusinessDnaService: mocks.reactivateBusinessDnaService,
}));

import {
  createBusinessDnaServiceAction,
  updateBusinessDnaServiceAction,
} from "@/actions/business-dna-services";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("business-dna-services actions — price (major-unit) to priceCents conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({
      userId: "user-1",
      email: "u@example.com",
      orgId: "org-a",
      role: "MANAGER",
      locale: "en",
    });
  });

  it("converts a decimal major-unit price string into integer cents", async () => {
    await createBusinessDnaServiceAction({}, formData({ name: "Haircut", price: "10.50" }));

    expect(mocks.createBusinessDnaService).toHaveBeenCalledTimes(1);
    const data = mocks.createBusinessDnaService.mock.calls[0]![1] as { priceCents?: number };
    expect(data.priceCents).toBe(1050);
  });

  it("rounds a price with more than 2 decimal places rather than truncating unpredictably", async () => {
    await createBusinessDnaServiceAction({}, formData({ name: "Haircut", price: "10.505" }));

    const data = mocks.createBusinessDnaService.mock.calls[0]![1] as { priceCents?: number };
    expect(data.priceCents).toBe(1051);
  });

  it("omits priceCents entirely when price is left blank (quote-only pricing via priceNote)", async () => {
    await createBusinessDnaServiceAction(
      {},
      formData({ name: "Consultation", price: "", priceNote: "Contact for a quote" }),
    );

    expect(mocks.createBusinessDnaService).toHaveBeenCalledTimes(1);
    const data = mocks.createBusinessDnaService.mock.calls[0]![1] as { priceCents?: number };
    expect(data.priceCents).toBeUndefined();
  });

  it("fails closed with invalid_input on a garbled, non-numeric price instead of silently dropping it", async () => {
    const result = await createBusinessDnaServiceAction(
      {},
      formData({ name: "Haircut", price: "not-a-number" }),
    );

    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.createBusinessDnaService).not.toHaveBeenCalled();
  });

  it("rejects a negative price", async () => {
    const result = await createBusinessDnaServiceAction(
      {},
      formData({ name: "Haircut", price: "-5" }),
    );
    expect(result).toEqual({ error: "invalid_input" });
  });

  it("treats the isActive checkbox as false when absent from the submitted form", async () => {
    await createBusinessDnaServiceAction({}, formData({ name: "Haircut" }));
    const data = mocks.createBusinessDnaService.mock.calls[0]![1] as { isActive: boolean };
    expect(data.isActive).toBe(false);
  });

  it("passes the edited service id through to the update action, not from form data", async () => {
    await updateBusinessDnaServiceAction(
      "svc-target",
      {},
      formData({ name: "Renamed", price: "5" }),
    );

    expect(mocks.updateBusinessDnaService).toHaveBeenCalledWith(
      expect.anything(),
      "svc-target",
      expect.objectContaining({ name: "Renamed", priceCents: 500 }),
    );
  });

  it("requires business-dna:write for both create and update", async () => {
    await createBusinessDnaServiceAction({}, formData({ name: "Haircut" }));
    await updateBusinessDnaServiceAction("svc-1", {}, formData({ name: "Haircut" }));
    expect(mocks.requirePermission).toHaveBeenCalledWith("business-dna:write");
  });
});
