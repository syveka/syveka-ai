import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * logActivity writes a note or task on a CRM contact. It runs after a
 * confirmed typed-chat action and directly from phone calls, where the caller
 * is anonymous, so its own audit row is the only record of a voice write.
 * The contact id comes from the model: a deleted contact must not receive new
 * activity, just as it is not offered in previews or search.
 *
 * Real: the tool, executeTool and its permission check. Mocked: the database
 * (a small in-memory contact table that honours `deletedAt: null`) and audit.
 */
const m = vi.hoisted(() => ({
  contacts: new Map<string, { id: string; deletedAt: Date | null }>(),
  activityCreate: vi.fn(),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}));

function findContact({ where }: { where: { id: string; deletedAt?: null } }) {
  const row = m.contacts.get(where.id);
  if (!row || ("deletedAt" in where && row.deletedAt !== null)) {
    return Promise.reject(new Error("No Contact found"));
  }
  return Promise.resolve(row);
}

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    contact: { findFirstOrThrow: vi.fn(findContact) },
    activity: { create: m.activityCreate },
  })),
  unscopedPrisma: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));

import { TOOL_REGISTRY, executeTool, type ToolIdentity } from "@/server/ai/tools";

const logActivity = TOOL_REGISTRY.find((t) => t.name === "logActivity")!;

const LIVE = "11111111-1111-4111-8111-111111111111";
const DELETED = "22222222-2222-4222-8222-222222222222";

const voiceAi: ToolIdentity = {
  orgId: "org-a",
  userId: "owner-1",
  role: "MANAGER",
  actorType: "voice_ai",
};
const chatUser: ToolIdentity = {
  orgId: "org-a",
  userId: "user-1",
  role: "MEMBER",
  actorType: "user",
};

const note = (contactId: string) => ({ contactId, type: "NOTE" as const, subject: "Called back" });

beforeEach(() => {
  vi.clearAllMocks();
  m.contacts.clear();
  m.contacts.set(LIVE, { id: LIVE, deletedAt: null });
  m.contacts.set(DELETED, { id: DELETED, deletedAt: new Date("2026-10-01T00:00:00Z") });
  m.activityCreate.mockResolvedValue({ id: "activity-1" });
});

describe("logActivity tool", () => {
  it("records an audit row for the activity it creates, with the caller's actor type", async () => {
    await expect(logActivity.execute(voiceAi, note(LIVE), {})).resolves.toEqual({
      id: "activity-1",
      created: true,
    });

    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      { orgId: "org-a", userId: "owner-1" },
      {
        action: "activity.create",
        resourceType: "activity",
        resourceId: "activity-1",
        actorType: "voice_ai",
        after: { contactId: LIVE, type: "NOTE", subject: "Called back" },
      },
    );
  });

  it("audits only after the activity exists", async () => {
    await logActivity.execute(chatUser, note(LIVE), {});

    expect(m.activityCreate.mock.invocationCallOrder[0]!).toBeLessThan(
      m.audit.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses a deleted contact: no activity and no audit row", async () => {
    await expect(logActivity.execute(voiceAi, note(DELETED), {})).rejects.toThrow();

    expect(m.activityCreate).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("executeTool failure result", () => {
  it("does not hand raw internal error text to the model, and logs the failure without it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.activityCreate.mockRejectedValueOnce(
      new Error('Invalid `prisma.activity.create()` invocation: column "secret_internal" missing'),
    );

    const text = await executeTool(voiceAi, "logActivity", note(LIVE));

    expect(JSON.parse(text)).toEqual({ error: "execution_failed" });
    expect(text).not.toContain("prisma");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toEqual({
      event: "ai_tool_execution_failed",
      tool: "logActivity",
      orgId: "org-a",
      actorType: "voice_ai",
      errorName: "Error",
    });
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("secret_internal");
    errorSpy.mockRestore();
  });
});
