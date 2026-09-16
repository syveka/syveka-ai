import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as VoiceServiceModule from "@/server/services/voice";

/**
 * Regression: attachPhoneNumberAction must return controlled VoiceActionState
 * results for every known failure mode, never an uncaught exception.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async () => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "OWNER",
    locale: "en",
  })),
  attachPhoneNumber: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/voice", async () => {
  const actual = await vi.importActual<typeof VoiceServiceModule>("@/server/services/voice");
  return {
    upsertAssistant: vi.fn(),
    activateAssistant: vi.fn(),
    attachPhoneNumber: mocks.attachPhoneNumber,
    DuplicatePhoneNumberError: actual.DuplicatePhoneNumberError,
    AssistantNotSyncedError: actual.AssistantNotSyncedError,
  };
});
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { attachPhoneNumberAction } from "@/actions/voice";
import { DuplicatePhoneNumberError, AssistantNotSyncedError } from "@/server/services/voice";

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("attachPhoneNumberAction — controlled results, never a crash", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects malformed input before calling the service at all", async () => {
    const state = await attachPhoneNumberAction(
      "assistant-1",
      {},
      formData({ provider: "twilio", phoneNumber: "not-a-number" }),
    );

    expect(state).toEqual({ error: "invalid_input" });
    expect(mocks.attachPhoneNumber).not.toHaveBeenCalled();
  });

  it("returns a controlled error for a duplicate phone number instead of throwing", async () => {
    mocks.attachPhoneNumber.mockRejectedValue(new DuplicatePhoneNumberError("in use"));

    const state = await attachPhoneNumberAction(
      "assistant-1",
      {},
      formData({
        provider: "twilio",
        phoneNumber: "+358401234567",
        twilioAccountSid: "AC1",
        twilioAuthToken: "secret",
      }),
    );

    expect(state).toEqual({ error: "phone_number_in_use" });
  });

  it("returns a controlled error when the assistant hasn't synced to Vapi yet", async () => {
    mocks.attachPhoneNumber.mockRejectedValue(new AssistantNotSyncedError("not synced"));

    const state = await attachPhoneNumberAction(
      "assistant-1",
      {},
      formData({
        provider: "twilio",
        phoneNumber: "+358401234567",
        twilioAccountSid: "AC1",
        twilioAuthToken: "secret",
      }),
    );

    expect(state).toEqual({ error: "assistant_not_synced" });
  });

  it("returns a plain success message once attached", async () => {
    mocks.attachPhoneNumber.mockResolvedValue({ id: "assistant-1", phoneNumber: "+358401234567" });

    const state = await attachPhoneNumberAction(
      "assistant-1",
      {},
      formData({
        provider: "twilio",
        phoneNumber: "+358401234567",
        twilioAccountSid: "AC1",
        twilioAuthToken: "secret",
      }),
    );

    expect(state).toEqual({ message: "phone_number_attached" });
  });

  it("never leaks a raw provider error message on an unexpected failure (adversarial finding, fixed)", async () => {
    // e.g. a raw Vapi/Twilio 400 body (see vapiFetch's error construction,
    // which can carry up to 500 chars of the provider's own response text).
    mocks.attachPhoneNumber.mockRejectedValue(
      new Error(
        'Vapi POST /phone-number → 400: {"message":"Invalid Twilio Account SID or Auth Token"}',
      ),
    );

    const state = await attachPhoneNumberAction(
      "assistant-1",
      {},
      formData({
        provider: "twilio",
        phoneNumber: "+358401234567",
        twilioAccountSid: "AC1",
        twilioAuthToken: "secret",
      }),
    );

    expect(state).toEqual({ error: "generic" });
    expect(state.error).not.toContain("Twilio");
    expect(state.error).not.toContain("Vapi");
  });
});
