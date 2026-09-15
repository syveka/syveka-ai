import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: activateAssistantAction must never let a provider-side failure
 * (e.g. Vapi phone-number provisioning, or any other unexpected error)
 * propagate as an uncaught exception into Next.js's generic server-error
 * crash page. saveAssistantAction already had this try/catch pattern;
 * activateAssistantAction did not -- this is what actually turned a routine
 * "no number available" outcome into the 2026-09-15 production incident.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "OWNER",
    locale: "en",
  })),
  activateAssistant: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/voice", () => ({
  activateAssistant: mocks.activateAssistant,
  upsertAssistant: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { activateAssistantAction } from "@/actions/voice";

describe("activateAssistantAction — controlled results, never a crash", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns phoneNumberPending instead of throwing when the assistant synced but no number could be provisioned", async () => {
    mocks.activateAssistant.mockResolvedValue({
      assistant: { id: "assistant-1", isActive: false, phoneNumber: null },
      phoneNumberError: "Vapi POST /phone-number → 400: area code unavailable",
    });

    const state = await activateAssistantAction("assistant-1", {});

    expect(state).toEqual({ phoneNumberPending: true });
    expect(state.error).toBeUndefined();
  });

  it("returns a controlled error instead of throwing when the underlying service call rejects unexpectedly", async () => {
    mocks.activateAssistant.mockRejectedValue(new Error("Vapi is unreachable"));

    const state = await activateAssistantAction("assistant-1", {});

    expect(state.error).toBe("Vapi is unreachable");
    expect(state.phoneNumberPending).toBeUndefined();
  });

  it("returns a plain success message once the number is provisioned", async () => {
    mocks.activateAssistant.mockResolvedValue({
      assistant: { id: "assistant-1", isActive: true, phoneNumber: "+358401234567" },
      phoneNumberError: null,
    });

    const state = await activateAssistantAction("assistant-1", {});

    expect(state).toEqual({ message: "activated" });
  });
});
