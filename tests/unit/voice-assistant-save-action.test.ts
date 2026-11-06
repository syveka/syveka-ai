import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * saveAssistantAction: who may save, and what the person saving is told. After a failed Vapi sync
 * the choice is already saved, so "try again" alone would mislead them about whether calls are
 * being recorded. The service is mocked here; voice-recording-setting.test.ts covers it.
 */
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  upsertAssistant: vi.fn(),
  revalidatePath: vi.fn(),
  actionWriteLimitError: vi.fn(async () => null as string | null),
  redirect: vi.fn(),
}));

class FakeSyncFailed extends Error {}

vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/security/rate-limit", () => ({
  actionWriteLimitError: mocks.actionWriteLimitError,
}));
vi.mock("@/server/services/voice", () => ({
  upsertAssistant: mocks.upsertAssistant,
  get VoiceSyncFailedError() {
    return FakeSyncFailed;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

const { saveAssistantAction } = await import("@/actions/voice");

function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  const fields = {
    name: "Reception",
    language: "FI",
    voiceProvider: "azure",
    firstMessage: "Hei!",
    systemPrompt: "Olet avulias vastaanottovirkailija.",
    useKnowledgeBase: "false",
    recording: "off",
    ...overrides,
  };
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ userId: "user-1", orgId: "org-a", role: "OWNER" });
  mocks.actionWriteLimitError.mockResolvedValue(null);
  mocks.upsertAssistant.mockResolvedValue({ id: "assistant-1" });
});

describe("saveAssistantAction", () => {
  it("needs voice:configure, and saves nothing without it", async () => {
    mocks.requirePermission.mockRejectedValueOnce(new Error("forbidden"));

    await expect(saveAssistantAction("assistant-1", {}, form())).rejects.toThrow("forbidden");

    expect(mocks.requirePermission).toHaveBeenCalledWith("voice:configure");
    expect(mocks.upsertAssistant).not.toHaveBeenCalled();
  });

  it("takes the organization from the session, and ignores one in the form", async () => {
    await saveAssistantAction("assistant-1", {}, form({ organizationId: "org-b", orgId: "org-b" }));

    const [ctx, input] = mocks.upsertAssistant.mock.calls[0]!;
    expect(ctx.orgId).toBe("org-a");
    expect(input).not.toHaveProperty("organizationId");
    expect(input).not.toHaveProperty("orgId");
  });

  it("rejects a recording value that isn't offered", async () => {
    const state = await saveAssistantAction("assistant-1", {}, form({ recording: "always" }));

    expect(state).toEqual({ error: "invalid_input" });
    expect(mocks.upsertAssistant).not.toHaveBeenCalled();
  });

  it("says the save stands when only the Vapi sync failed, and refreshes the page", async () => {
    mocks.upsertAssistant.mockRejectedValueOnce(new FakeSyncFailed());

    const state = await saveAssistantAction("assistant-1", {}, form());

    expect(state).toEqual({ error: "sync_failed" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/voice");
  });

  it("stays generic for any other failure, with no provider text", async () => {
    mocks.upsertAssistant.mockRejectedValueOnce(new Error("Vapi 500: secret-provider-detail"));

    const state = await saveAssistantAction("assistant-1", {}, form());

    expect(state).toEqual({ error: "generic" });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("the messages it can return", () => {
  it.each(["en", "fi", "ar"])("%s has text for every save error", async (locale) => {
    const { default: messages } = await import(`../../messages/${locale}.json`);
    for (const code of ["generic", "invalid_input", "sync_failed"]) {
      expect(messages.voice.errors[code], code).toBeTruthy();
    }
    expect(messages.voice.errors.sync_failed).not.toBe(messages.voice.errors.generic);
  });
});
