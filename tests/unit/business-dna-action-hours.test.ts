import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * The form sends openingHours only when the user changed them. The action
 * must keep stored hours when the field is missing (an unrelated edit), and
 * pass a sent week or an explicit null through unchanged.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async (): Promise<TenantContext> => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "MANAGER",
    locale: "en",
  })),
  upsertBusinessDNA: vi.fn(async (..._args: unknown[]) => ({
    ok: true as const,
    record: { id: "bd-1", updatedAt: new Date("2026-11-22T12:00:00.000Z") },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/security/rate-limit", () => ({ actionRateLimitError: vi.fn(async () => null) }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/business-dna", () => ({
  getBusinessDNA: vi.fn(),
  upsertBusinessDNA: mocks.upsertBusinessDNA,
}));

import { updateBusinessDnaAction } from "@/actions/business-dna";
import { normalizeOpeningHours } from "@/lib/business-dna/opening-hours";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const call = () => mocks.upsertBusinessDNA.mock.calls[0]!;

beforeEach(() => vi.clearAllMocks());

describe("updateBusinessDnaAction opening hours", () => {
  it("keeps stored hours when the form sends none", async () => {
    await updateBusinessDnaAction({}, form({ displayName: "Acme" }));
    expect((call()[1] as { openingHours?: unknown }).openingHours).toBeUndefined();
    expect(call()[3]).toEqual({ keepOpeningHours: true });
  });

  it("stores a sent all-closed week as sent", async () => {
    const week = normalizeOpeningHours(null);
    await updateBusinessDnaAction(
      {},
      form({ displayName: "Acme", openingHours: JSON.stringify(week) }),
    );
    expect(call()[1]).toMatchObject({ openingHours: week });
    expect(call()[3]).toEqual({ keepOpeningHours: false });
  });

  it("passes an explicit clear through", async () => {
    await updateBusinessDnaAction({}, form({ displayName: "Acme", openingHours: "null" }));
    expect(call()[1]).toMatchObject({ openingHours: null });
    expect(call()[3]).toEqual({ keepOpeningHours: false });
  });
});
