import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression: deactivateAssistantAction must return a controlled
 * VoiceActionState for every outcome, never an uncaught exception, and
 * never leak a raw provider/DB error message to the client.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "OWNER",
    locale: "en",
  })),
  deactivateAssistant: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/voice", () => ({
  upsertAssistant: vi.fn(),
  activateAssistant: vi.fn(),
  deactivateAssistant: mocks.deactivateAssistant,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { deactivateAssistantAction } from "@/actions/voice";

describe("deactivateAssistantAction — controlled results, never a crash", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a plain success message once deactivated", async () => {
    mocks.deactivateAssistant.mockResolvedValue({ id: "assistant-1", isActive: false });

    const state = await deactivateAssistantAction("assistant-1", {});

    expect(state).toEqual({ message: "deactivated" });
  });

  it("returns a controlled, generic error instead of throwing or leaking a raw message on failure", async () => {
    mocks.deactivateAssistant.mockRejectedValue(
      new Error("some internal DB detail that must not reach the client"),
    );

    const state = await deactivateAssistantAction("assistant-1", {});

    expect(state).toEqual({ error: "generic" });
  });
});
