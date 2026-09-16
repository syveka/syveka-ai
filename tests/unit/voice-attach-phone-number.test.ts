import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { AttachPhoneNumberInput } from "@/lib/validators/voice";

/**
 * Coverage for attachPhoneNumber() (src/server/services/voice.ts) -- the
 * BYO/Twilio-import path built to work around Vapi's native phone-number
 * pool being US/Canada-only (see src/server/integrations/vapi.ts's
 * buyPhoneNumber doc comment and the 2026-09-15 production incident). No
 * real provider call is made anywhere in this file -- importPhoneNumber is
 * a pure mock.
 */
const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  unscopedFindFirst: vi.fn(),
  txFindFirst: vi.fn(),
  txUpdate: vi.fn(),
  txExecuteRaw: vi.fn(),
  importPhoneNumber: vi.fn(),
  auditMock: vi.fn(async (_ctx: unknown, _input: { after: Record<string, unknown> }) => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    voiceAssistant: { findFirst: mocks.unscopedFindFirst },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        voiceAssistant: { findFirst: mocks.txFindFirst, update: mocks.txUpdate },
        $executeRaw: mocks.txExecuteRaw,
      }),
  },
}));
vi.mock("@/server/integrations/vapi", () => ({
  upsertVapiAssistant: vi.fn(),
  buyPhoneNumber: vi.fn(),
  importPhoneNumber: mocks.importPhoneNumber,
}));
vi.mock("@/server/services/audit", () => ({ audit: mocks.auditMock }));

import {
  attachPhoneNumber,
  DuplicatePhoneNumberError,
  AssistantNotSyncedError,
} from "@/server/services/voice";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

function assistantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assistant-1",
    organizationId: "org-a",
    vapiAssistantId: "vapi-assistant-1",
    phoneNumber: null,
    isActive: false,
    ...overrides,
  };
}

const twilioInput: AttachPhoneNumberInput = {
  provider: "twilio",
  phoneNumber: "+358401234567",
  twilioAccountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  twilioAuthToken: "super-secret-token",
};

describe("attachPhoneNumber", () => {
  let db: { voiceAssistant: { findFirstOrThrow: ReturnType<typeof vi.fn> } };

  beforeEach(() => {
    vi.clearAllMocks();
    db = { voiceAssistant: { findFirstOrThrow: vi.fn(async () => assistantRow()) } };
    mocks.tenantDb.mockReturnValue(db);
    mocks.unscopedFindFirst.mockResolvedValue(null); // no other owner by default (fast path)
    mocks.txFindFirst.mockResolvedValue(null); // no other owner by default (lock-protected re-check)
    mocks.txUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...assistantRow(),
      ...data,
    }));
    mocks.txExecuteRaw.mockResolvedValue(undefined);
    mocks.importPhoneNumber.mockResolvedValue({ id: "vapi-number-1", number: "+358401234567" });
  });

  it("rejects attaching a number when the assistant has never synced to Vapi", async () => {
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(assistantRow({ vapiAssistantId: null }));

    await expect(attachPhoneNumber(ctx(), "assistant-1", twilioInput)).rejects.toBeInstanceOf(
      AssistantNotSyncedError,
    );
    expect(mocks.importPhoneNumber).not.toHaveBeenCalled();
  });

  it("rejects a number already attached to a different assistant (cross-tenant duplicate protection)", async () => {
    mocks.unscopedFindFirst.mockResolvedValue({ id: "some-other-assistant" });

    await expect(attachPhoneNumber(ctx(), "assistant-1", twilioInput)).rejects.toBeInstanceOf(
      DuplicatePhoneNumberError,
    );
    expect(mocks.importPhoneNumber).not.toHaveBeenCalled();
    // Duplicate check must not be scoped to just this org -- two different
    // Syveka orgs can never legitimately hold the same real external number.
    expect(mocks.unscopedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phoneNumber: "+358401234567" }),
      }),
    );
  });

  it("is idempotent: re-attaching the exact number already on this assistant is a no-op, not a second import call", async () => {
    db.voiceAssistant.findFirstOrThrow.mockResolvedValue(
      assistantRow({ phoneNumber: "+358401234567" }),
    );

    const result = await attachPhoneNumber(ctx(), "assistant-1", twilioInput);

    expect(mocks.importPhoneNumber).not.toHaveBeenCalled();
    expect(mocks.txUpdate).not.toHaveBeenCalled();
    expect(result.phoneNumber).toBe("+358401234567");
  });

  it("attaches a Twilio-imported number and marks the assistant active", async () => {
    const result = await attachPhoneNumber(ctx(), "assistant-1", twilioInput);

    expect(mocks.importPhoneNumber).toHaveBeenCalledWith(
      "vapi-assistant-1",
      expect.objectContaining({ provider: "twilio", phoneNumber: "+358401234567" }),
    );
    expect(result.phoneNumber).toBe("+358401234567");
    expect(result.isActive).toBe(true);
  });

  it("locks on the phone number before the authoritative write (adversarial-review hardening)", async () => {
    await attachPhoneNumber(ctx(), "assistant-1", twilioInput);

    expect(mocks.txExecuteRaw).toHaveBeenCalledTimes(1);
    const lockArgs = mocks.txExecuteRaw.mock.calls[0] as unknown[];
    // pg_advisory_xact_lock(hashtext(<phone number>), 2) -- see
    // src/server/calendar/locks.ts's lockPhoneNumber for the fixed key `2`.
    expect(JSON.stringify(lockArgs)).toContain("+358401234567");
  });

  it("rejects the write when a race is caught under the lock, even though the fast-path check already passed", async () => {
    mocks.unscopedFindFirst.mockResolvedValue(null); // fast path: clear
    mocks.txFindFirst.mockResolvedValue({ id: "raced-in-between-assistant" }); // lock-protected re-check: taken

    await expect(attachPhoneNumber(ctx(), "assistant-1", twilioInput)).rejects.toBeInstanceOf(
      DuplicatePhoneNumberError,
    );
    expect(mocks.txUpdate).not.toHaveBeenCalled();
  });

  it("attaches a BYO/SIP-imported number", async () => {
    const byoInput: AttachPhoneNumberInput = {
      provider: "byo-phone-number",
      phoneNumber: "+358401234567",
      sipUri: "sip:syveka@example-sip-trunk.invalid",
    };

    await attachPhoneNumber(ctx(), "assistant-1", byoInput);

    expect(mocks.importPhoneNumber).toHaveBeenCalledWith(
      "vapi-assistant-1",
      expect.objectContaining({ provider: "byo-phone-number", phoneNumber: "+358401234567" }),
    );
  });

  it("never persists Twilio credentials to the database", async () => {
    await attachPhoneNumber(ctx(), "assistant-1", twilioInput);

    const updateCall = mocks.txUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateCall.data).not.toHaveProperty("twilioAccountSid");
    expect(updateCall.data).not.toHaveProperty("twilioAuthToken");
    expect(JSON.stringify(updateCall.data)).not.toContain("super-secret-token");
  });

  it("audits the attach action with the provider, never with credentials", async () => {
    await attachPhoneNumber(ctx(), "assistant-1", twilioInput);

    expect(mocks.auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "voice_assistant.attach_phone_number",
        after: expect.objectContaining({ provider: "twilio", phoneNumber: "+358401234567" }),
      }),
    );
    const auditCall = mocks.auditMock.mock.calls[0]![1] as { after: Record<string, unknown> };
    expect(JSON.stringify(auditCall.after)).not.toContain("super-secret-token");
  });
});
